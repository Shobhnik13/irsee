package irc

import (
	"bufio"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"irsee/backend/netcount"
)

// ServerConfig is one saved server; it is also what the UI edits.
type ServerConfig struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Host        string   `json:"host"`
	Port        int      `json:"port"`
	TLS         bool     `json:"tls"`
	Insecure    bool     `json:"insecure"`
	Nick        string   `json:"nick"`
	User        string   `json:"user"`
	RealName    string   `json:"realname"`
	Password    string   `json:"password"`
	SASLUser    string   `json:"saslUser"`
	SASLPass    string   `json:"saslPass"`
	DCCHost     string   `json:"dccHost"`
	Channels    []string `json:"channels"`
	AutoConnect bool     `json:"autoConnect"`
}

// Handler receives what a Client reports. Calls come from the client's own goroutines.
type Handler struct {
	Message func(m *Message)
	State   func(state, nick, errMsg string)
	DCC     func(nick, text string, notice bool)
}

const (
	readTimeout  = 240 * time.Second
	pingInterval = 90 * time.Second
	sendBurst    = 8
	sendPerSec   = 2.0
)

var wantedCaps = []string{"multi-prefix", "server-time", "message-tags", "away-notify", "account-notify", "extended-join", "chghost", "invite-notify", "cap-notify"}

// Client owns one server connection and reconnects with backoff until stopped.
type Client struct {
	cfg  ServerConfig
	h    Handler
	out  chan string
	stop chan struct{}
	once sync.Once

	mu   sync.Mutex
	conn net.Conn
	nick string

	wmu sync.Mutex
}

type regState struct {
	caps       map[string]string
	registered bool
}

// NewClient fills config defaults and builds an idle client.
func NewClient(cfg ServerConfig, h Handler) *Client {
	if cfg.Port == 0 {
		cfg.Port = 6667
		if cfg.TLS {
			cfg.Port = 6697
		}
	}
	if cfg.User == "" {
		cfg.User = cfg.Nick
	}
	if cfg.RealName == "" {
		cfg.RealName = cfg.Nick
	}

	return &Client{cfg: cfg, h: h, out: make(chan string, 1024), stop: make(chan struct{}), nick: cfg.Nick}
}

// Config returns the config this client was started with (defaults filled in).
func (c *Client) Config() ServerConfig {
	return c.cfg
}

// Start runs the connect/reconnect loop in the background.
func (c *Client) Start() {
	go c.run()
}

// Stop sends QUIT, closes the socket, and ends the reconnect loop.
func (c *Client) Stop(reason string) {
	c.once.Do(func() {
		close(c.stop)
		c.mu.Lock()
		conn := c.conn
		c.mu.Unlock()
		if conn != nil {
			_ = c.write(conn, "QUIT :"+reason)
			conn.Close()
		}
	})
}

// Send splits text on newlines and queues each line for the rate-limited writer.
func (c *Client) Send(line string) error {
	c.mu.Lock()
	connected := c.conn != nil
	c.mu.Unlock()
	if !connected {
		return errors.New("not connected")
	}

	for _, l := range strings.FieldsFunc(line, func(r rune) bool { return r == '\r' || r == '\n' }) {
		select {
		case c.out <- l:
		default:
			return errors.New("send queue full")
		}
	}
	return nil
}

// run connects, and after each disconnect waits with exponential backoff and retries.
func (c *Client) run() {
	backoff := time.Second
	for {
		c.emitState("connecting", "")
		started := time.Now()
		err := c.session()

		select {
		case <-c.stop:
			c.emitState("disconnected", "")
			return
		default:
		}

		if time.Since(started) > 2*time.Minute {
			backoff = time.Second
		}
		msg := "connection closed"
		if err != nil {
			msg = err.Error()
		}
		c.emitState("reconnecting", fmt.Sprintf("%s — retrying in %s", msg, backoff))

		select {
		case <-c.stop:
			c.emitState("disconnected", "")
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, time.Minute)
	}
}

// session handles one connection: dial, TLS, register, then read lines until it drops.
func (c *Client) session() error {
	addr := net.JoinHostPort(c.cfg.Host, strconv.Itoa(c.cfg.Port))
	dialer := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: time.Minute}

	raw, err := dialer.Dial("tcp", addr)
	if err != nil {
		return err
	}
	conn := netcount.Wrap(raw)
	defer conn.Close()

	if c.cfg.TLS {
		tc := tls.Client(conn, &tls.Config{ServerName: c.cfg.Host, InsecureSkipVerify: c.cfg.Insecure, MinVersion: tls.VersionTLS12})
		_ = tc.SetDeadline(time.Now().Add(15 * time.Second))
		if err := tc.Handshake(); err != nil {
			return err
		}
		_ = tc.SetDeadline(time.Time{})
		conn = tc
	}

drain:
	for {
		select {
		case <-c.out:
		default:
			break drain
		}
	}

	c.mu.Lock()
	c.conn = conn
	c.nick = c.cfg.Nick
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.conn = nil
		c.mu.Unlock()
	}()

	select {
	case <-c.stop:
		return nil
	default:
	}

	done := make(chan struct{})
	defer close(done)
	go c.writer(conn, done)
	go c.pinger(conn, done)

	_ = c.write(conn, "CAP LS 302")
	if c.cfg.Password != "" {
		_ = c.write(conn, "PASS "+c.cfg.Password)
	}
	_ = c.write(conn, "NICK "+c.cfg.Nick)
	_ = c.write(conn, fmt.Sprintf("USER %s 0 * :%s", c.cfg.User, c.cfg.RealName))

	st := &regState{caps: map[string]string{}}
	sc := bufio.NewScanner(conn)
	sc.Buffer(make([]byte, 0, 16*1024), 64*1024)

	for {
		_ = conn.SetReadDeadline(time.Now().Add(readTimeout))
		if !sc.Scan() {
			break
		}
		line := strings.TrimRight(sc.Text(), "\r")
		if line == "" {
			continue
		}
		m, err := ParseMessage(line)
		if err != nil {
			continue
		}
		if c.handle(conn, m, st) {
			continue
		}
		c.h.Message(m)
	}

	if err := sc.Err(); err != nil {
		return err
	}
	return errors.New("connection closed by server")
}

// handle processes protocol-level lines; returns true when the line should not reach the UI.
func (c *Client) handle(conn net.Conn, m *Message, st *regState) bool {
	switch m.Command {
	case "PING":
		_ = c.write(conn, "PONG :"+m.Param(0))
		return true

	case "PONG":
		return true

	case "PRIVMSG", "NOTICE":
		if text := m.Last(); strings.HasPrefix(text, "\x01DCC ") && c.h.DCC != nil && c.isMe(m.Param(0)) {
			c.h.DCC(m.Nick, strings.TrimRight(text[5:], "\x01"), m.Command == "NOTICE")
			return true
		}

	case "CAP":
		if st.registered {
			return false
		}
		switch strings.ToUpper(m.Param(1)) {
		case "LS":
			for _, cp := range strings.Fields(m.Last()) {
				k, v, _ := strings.Cut(cp, "=")
				st.caps[k] = v
			}
			if len(m.Params) >= 4 && m.Params[2] == "*" {
				return true
			}
			var req []string
			for _, w := range wantedCaps {
				if _, ok := st.caps[w]; ok {
					req = append(req, w)
				}
			}
			if _, ok := st.caps["sasl"]; ok && c.cfg.SASLUser != "" && c.cfg.SASLPass != "" {
				req = append(req, "sasl")
			}
			if len(req) == 0 {
				_ = c.write(conn, "CAP END")
			} else {
				_ = c.write(conn, "CAP REQ :"+strings.Join(req, " "))
			}
			return true
		case "ACK":
			if strings.Contains(" "+m.Last()+" ", " sasl ") {
				_ = c.write(conn, "AUTHENTICATE PLAIN")
			} else {
				_ = c.write(conn, "CAP END")
			}
		case "NAK":
			_ = c.write(conn, "CAP END")
		}

	case "AUTHENTICATE":
		if m.Param(0) == "+" {
			payload := base64.StdEncoding.EncodeToString([]byte(c.cfg.SASLUser + "\x00" + c.cfg.SASLUser + "\x00" + c.cfg.SASLPass))
			for len(payload) >= 400 {
				_ = c.write(conn, "AUTHENTICATE "+payload[:400])
				payload = payload[400:]
			}
			if payload == "" {
				payload = "+"
			}
			_ = c.write(conn, "AUTHENTICATE "+payload)
		}
		return true

	case "903", "904", "905", "906", "907":
		if !st.registered {
			_ = c.write(conn, "CAP END")
		}

	case "001":
		st.registered = true
		c.mu.Lock()
		c.nick = m.Param(0)
		c.mu.Unlock()
		c.emitState("registered", "")

	case "432", "433", "437":
		if !st.registered {
			c.mu.Lock()
			c.nick += "_"
			nick := c.nick
			c.mu.Unlock()
			_ = c.write(conn, "NICK "+nick)
		}

	case "NICK":
		c.mu.Lock()
		if strings.EqualFold(m.Nick, c.nick) {
			c.nick = m.Param(0)
		}
		c.mu.Unlock()
	}

	return false
}

// isMe reports whether nick is our current nick.
func (c *Client) isMe(nick string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return strings.EqualFold(nick, c.nick)
}

// LocalIP returns our side of the IRC socket, used as the default DCC address.
func (c *Client) LocalIP() net.IP {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return nil
	}
	if a, ok := c.conn.LocalAddr().(*net.TCPAddr); ok {
		return a.IP
	}
	return nil
}

// writer drains the send queue with a token bucket so the server does not kick us for flooding.
func (c *Client) writer(conn net.Conn, done chan struct{}) {
	tokens := float64(sendBurst)
	last := time.Now()
	for {
		select {
		case <-done:
			return
		case line := <-c.out:
			now := time.Now()
			tokens = math.Min(sendBurst, tokens+now.Sub(last).Seconds()*sendPerSec)
			last = now
			if tokens < 1 {
				wait := time.Duration((1 - tokens) / sendPerSec * float64(time.Second))
				select {
				case <-done:
					return
				case <-time.After(wait):
				}
				tokens = 1
				last = time.Now()
			}
			tokens--
			if err := c.write(conn, line); err != nil {
				conn.Close()
				return
			}
		}
	}
}

// pinger sends a PING every 90s so dead connections are noticed.
func (c *Client) pinger(conn net.Conn, done chan struct{}) {
	t := time.NewTicker(pingInterval)
	defer t.Stop()
	for {
		select {
		case <-done:
			return
		case <-t.C:
			_ = c.write(conn, "PING :irsee")
		}
	}
}

// write sends one line immediately, bypassing the queue (used for PONG/CAP/SASL).
func (c *Client) write(conn net.Conn, line string) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_ = conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
	_, err := io.WriteString(conn, line+"\r\n")
	return err
}

// emitState reports a connection state change to the handler.
func (c *Client) emitState(state, errMsg string) {
	c.mu.Lock()
	nick := c.nick
	c.mu.Unlock()
	c.h.State(state, nick, errMsg)
}
