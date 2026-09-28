// Package dcc implements DCC SEND file transfers (both directions, active and passive).
package dcc

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	goruntime "runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"irsee/backend/netcount"
)

// Transfer is the UI-visible state of one DCC SEND, in either direction.
type Transfer struct {
	ID      string `json:"id"`
	Server  string `json:"server"`
	Nick    string `json:"nick"`
	Name    string `json:"name"`
	Path    string `json:"path,omitempty"`
	Size    int64  `json:"size"`
	Done    int64  `json:"done"`
	Speed   int64  `json:"speed"`
	Dir     string `json:"dir"`
	State   string `json:"state"`
	Peer    string `json:"peer,omitempty"`
	Passive bool   `json:"passive"`
	Error   string `json:"error,omitempty"`
}

type transfer struct {
	Transfer
	ip       net.IP
	port     int
	token    string
	ctx      context.Context
	cancel   context.CancelFunc
	lastEmit time.Time
	lastDone int64
}

const (
	dccWait        = 2 * time.Minute
	dccOfferExpiry = 10 * time.Minute
	dccBuf         = 64 * 1024
)

var (
	errDCCCancelled = errors.New("cancelled")
	errMalformed    = errors.New("malformed DCC offer")
	errNoConnect    = errors.New("peer did not connect in time")
)

// Hooks connect the manager to the rest of the app without importing it.
type Hooks struct {
	Send func(server, line string) error // send a raw IRC line on a server
	IP   func(server string) net.IP      // address peers should connect to
	Emit func(t Transfer)                // push a transfer update to the UI
}

// Manager tracks every transfer and runs them in background goroutines.
type Manager struct {
	hooks Hooks
	mu    sync.Mutex
	list  map[string]*transfer
	seq   int
}

// New creates an empty transfer manager.
func New(h Hooks) *Manager {
	return &Manager{hooks: h, list: map[string]*transfer{}}
}

// ---------- Incoming CTCP ----------

// Handle processes an incoming CTCP DCC message: a new offer, or a reply to our passive offer.
func (d *Manager) Handle(server, nick, text string, notice bool) {
	cmd, args, _ := strings.Cut(text, " ")
	cmd = strings.ToUpper(cmd)

	if notice {
		if cmd == "REJECT" {
			d.peerRejected(server, nick, args)
		}
		return
	}
	if cmd != "SEND" {
		return
	}

	name, ip, port, size, token, err := parseDCCSend(args)
	if err != nil {
		return
	}

	if port != 0 && token != "" {
		d.mu.Lock()
		var match *transfer
		for _, t := range d.list {
			if t.Dir == "send" && t.Passive && t.State == "waiting" && t.token == token && t.Server == server && strings.EqualFold(t.Nick, nick) {
				match = t
				t.ip, t.port = ip, port
				t.Peer = net.JoinHostPort(ip.String(), strconv.Itoa(port))
				t.State = "connecting"
			}
		}
		d.mu.Unlock()
		if match != nil {
			d.emit(match)
			go d.sendConnect(match)
			return
		}
	}

	t := d.add(Transfer{Server: server, Nick: nick, Name: sanitizeName(name), Size: size, Dir: "recv", State: "offered", Passive: port == 0})
	t.ip, t.port, t.token = ip, port, token
	if port != 0 {
		t.Peer = net.JoinHostPort(ip.String(), strconv.Itoa(port))
	}
	d.emit(t)

	time.AfterFunc(dccOfferExpiry, func() {
		d.finish(t, "failed", errors.New("offer expired"), "offered")
	})
}

// peerRejected marks our pending offer as rejected when the peer sends DCC REJECT.
func (d *Manager) peerRejected(server, nick, args string) {
	_, name, _ := strings.Cut(args, " ")
	name = strings.Trim(name, `"`)
	d.mu.Lock()
	var hit []*transfer
	for _, t := range d.list {
		if t.Dir == "send" && t.State == "waiting" && t.Server == server && strings.EqualFold(t.Nick, nick) && t.Name == sendName(name) {
			hit = append(hit, t)
		}
	}
	d.mu.Unlock()
	for _, t := range hit {
		d.finish(t, "rejected", nil)
	}
}

// ---------- Public API ----------

// Get returns a snapshot of one transfer.
func (d *Manager) Get(id string) (Transfer, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	t, ok := d.list[id]
	if !ok {
		return Transfer{}, false
	}
	return t.Transfer, true
}

// Send offers the file at path to nick (active or passive) and returns the transfer id.
func (d *Manager) Send(server, nick, path string, passive bool) (string, error) {
	st, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if st.IsDir() {
		return "", errors.New("folders cannot be sent")
	}

	t := d.add(Transfer{Server: server, Nick: nick, Name: sendName(filepath.Base(path)), Path: path, Size: st.Size(), Dir: "send", State: "waiting", Passive: passive})

	if passive {
		t.token = randomToken()
		if err := d.hooks.Send(server, ctcpDCC(nick, t.Name, "0", 0, t.Size, t.token)); err != nil {
			d.finish(t, "failed", err)
			return t.ID, nil
		}
		d.emit(t)
		time.AfterFunc(dccWait, func() {
			d.finish(t, "failed", fmt.Errorf("no response from %s — their app may not support passive mode; try active mode", nick), "waiting")
		})
		return t.ID, nil
	}

	go d.sendListen(t)
	return t.ID, nil
}

// Accept starts receiving an offer into path, or into a new file in Downloads when path is "".
func (d *Manager) Accept(id, path string) error {
	t := d.get(id)
	if t == nil {
		return errors.New("offer is no longer available")
	}

	var f *os.File
	var err error
	if path != "" {
		f, err = os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	} else {
		f, err = createUnique(DownloadsDir(), t.Name)
	}
	if err != nil {
		return err
	}

	d.mu.Lock()
	if t.State != "offered" {
		d.mu.Unlock()
		f.Close()
		os.Remove(f.Name())
		return errors.New("offer is no longer available")
	}
	t.Path = f.Name()
	t.State = "connecting"
	d.mu.Unlock()
	d.emit(t)

	go d.receive(t, f)
	return nil
}

// Cancel rejects an offer (telling the sender) or stops a running transfer.
func (d *Manager) Cancel(id string) {
	t := d.get(id)
	if t == nil {
		return
	}
	d.mu.Lock()
	offered := t.State == "offered"
	d.mu.Unlock()
	if offered {
		_ = d.hooks.Send(t.Server, fmt.Sprintf("NOTICE %s :\x01DCC REJECT SEND %s\x01", t.Nick, sendName(t.Name)))
		d.finish(t, "rejected", nil, "offered")
		return
	}
	d.finish(t, "cancelled", nil)
}

// Reveal shows a transfer's file in Finder, Explorer, or the file manager.
func (d *Manager) Reveal(id string) error {
	t, ok := d.Get(id)
	if !ok || t.Path == "" {
		return errors.New("no file")
	}
	switch goruntime.GOOS {
	case "darwin":
		return exec.Command("open", "-R", t.Path).Start()
	case "windows":
		return exec.Command("explorer", "/select,", t.Path).Start()
	default:
		return exec.Command("xdg-open", filepath.Dir(t.Path)).Start()
	}
}

// Clear forgets finished, failed, cancelled, and rejected transfers.
func (d *Manager) Clear() {
	d.mu.Lock()
	defer d.mu.Unlock()
	for id, t := range d.list {
		switch t.State {
		case "done", "failed", "cancelled", "rejected":
			delete(d.list, id)
		}
	}
}

// ---------- Sending ----------

// sendListen (active send) opens a port, offers it, and waits for the peer to connect.
func (d *Manager) sendListen(t *transfer) {
	ln, err := net.Listen("tcp", ":0")
	if err != nil {
		d.finish(t, "failed", err)
		return
	}
	ip := d.hooks.IP(t.Server)
	if ip == nil {
		ln.Close()
		d.finish(t, "failed", errors.New("cannot determine local IP"))
		return
	}

	port := ln.Addr().(*net.TCPAddr).Port
	if err := d.hooks.Send(t.Server, ctcpDCC(t.Nick, t.Name, encodeIP(ip), port, t.Size, "")); err != nil {
		ln.Close()
		d.finish(t, "failed", err)
		return
	}
	d.set(t, func() { t.Peer = fmt.Sprintf("listening on %s:%d", ip, port) })

	conn, err := acceptOne(t.ctx, ln)
	if err != nil {
		d.finish(t, "failed", blockedHere(err, t.Nick, "try passive mode"), "waiting")
		return
	}
	d.sendStream(t, conn)
}

// sendConnect (passive send) connects to the port the peer opened.
func (d *Manager) sendConnect(t *transfer) {
	conn, err := dialPeer(t)
	if err != nil {
		d.finish(t, "failed", blockedThere(t, "try active mode"))
		return
	}
	d.sendStream(t, conn)
}

// sendStream writes the file to the socket and waits for the final ack.
func (d *Manager) sendStream(t *transfer, conn net.Conn) {
	conn = netcount.Wrap(conn)
	defer conn.Close()
	stop := context.AfterFunc(t.ctx, func() { conn.Close() })
	defer stop()

	f, err := os.Open(t.Path)
	if err != nil {
		d.finish(t, "failed", err)
		return
	}
	defer f.Close()

	d.set(t, func() {
		t.State = "active"
		t.Peer = conn.RemoteAddr().String()
	})

	want := uint32(t.Size)
	acked := make(chan struct{})
	go func() {
		defer close(acked)
		var b [4]byte
		for {
			if _, err := io.ReadFull(conn, b[:]); err != nil {
				return
			}
			if binary.BigEndian.Uint32(b[:]) == want {
				return
			}
		}
	}()

	buf := make([]byte, dccBuf)
	for {
		n, rerr := f.Read(buf)
		if n > 0 {
			if _, err := conn.Write(buf[:n]); err != nil {
				d.fail(t, err)
				return
			}
			d.progress(t, int64(n))
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			d.fail(t, rerr)
			return
		}
	}

	select {
	case <-acked:
	case <-time.After(30 * time.Second):
	case <-t.ctx.Done():
		d.fail(t, errDCCCancelled)
		return
	}
	d.finish(t, "done", nil)
}

// ---------- Receiving ----------

// receive connects (or listens, if passive), then writes incoming bytes to the file and sends acks.
func (d *Manager) receive(t *transfer, f *os.File) {
	defer f.Close()

	var conn net.Conn
	var err error
	if t.Passive {
		conn, err = d.receiveListen(t)
		err = blockedHere(err, t.Nick, "ask them to send in active mode")
	} else if conn, err = dialPeer(t); err != nil {
		err = blockedThere(t, "ask them to send in passive mode")
	}
	if err != nil {
		f.Close()
		os.Remove(f.Name())
		d.fail(t, err)
		return
	}
	conn = netcount.Wrap(conn)
	defer conn.Close()
	stop := context.AfterFunc(t.ctx, func() { conn.Close() })
	defer stop()

	d.set(t, func() {
		t.State = "active"
		t.Peer = conn.RemoteAddr().String()
	})

	buf := make([]byte, dccBuf)
	var ack [4]byte
	var total int64
	for t.Size <= 0 || total < t.Size {
		limit := len(buf)
		if t.Size > 0 && t.Size-total < int64(limit) {
			limit = int(t.Size - total)
		}
		n, rerr := conn.Read(buf[:limit])
		if n > 0 {
			if _, err := f.Write(buf[:n]); err != nil {
				d.fail(t, err)
				return
			}
			total += int64(n)
			binary.BigEndian.PutUint32(ack[:], uint32(total))
			_, _ = conn.Write(ack[:])
			d.progress(t, int64(n))
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			d.fail(t, rerr)
			return
		}
	}

	if t.Size > 0 && total < t.Size {
		d.fail(t, fmt.Errorf("incomplete: got %d of %d bytes", total, t.Size))
		return
	}
	d.finish(t, "done", nil)
}

// receiveListen (passive receive) opens a port, tells the sender, and waits for it.
func (d *Manager) receiveListen(t *transfer) (net.Conn, error) {
	ip := d.hooks.IP(t.Server)
	if ip == nil {
		return nil, errors.New("not connected")
	}
	ln, err := net.Listen("tcp", ":0")
	if err != nil {
		return nil, err
	}
	port := ln.Addr().(*net.TCPAddr).Port
	if err := d.hooks.Send(t.Server, ctcpDCC(t.Nick, sendName(t.Name), encodeIP(ip), port, t.Size, t.token)); err != nil {
		ln.Close()
		return nil, err
	}
	d.set(t, func() {
		t.State = "waiting"
		t.Peer = fmt.Sprintf("listening on %s:%d", ip, port)
	})
	return acceptOne(t.ctx, ln)
}

// ---------- State helpers ----------

// add registers a new transfer with its own cancel context.
func (d *Manager) add(tr Transfer) *transfer {
	ctx, cancel := context.WithCancel(context.Background())
	d.mu.Lock()
	d.seq++
	tr.ID = strconv.Itoa(d.seq)
	t := &transfer{Transfer: tr, ctx: ctx, cancel: cancel}
	d.list[tr.ID] = t
	d.mu.Unlock()
	return t
}

// get looks up a transfer by id.
func (d *Manager) get(id string) *transfer {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.list[id]
}

// set mutates a transfer under the lock and pushes it to the UI.
func (d *Manager) set(t *transfer, fn func()) {
	d.mu.Lock()
	fn()
	d.mu.Unlock()
	d.emit(t)
}

// progress adds bytes and emits at most 4 updates per second with the current speed.
func (d *Manager) progress(t *transfer, n int64) {
	d.mu.Lock()
	t.Done += n
	now := time.Now()
	since := now.Sub(t.lastEmit)
	if since < 250*time.Millisecond {
		d.mu.Unlock()
		return
	}
	if !t.lastEmit.IsZero() {
		t.Speed = int64(float64(t.Done-t.lastDone) / since.Seconds())
	}
	t.lastEmit, t.lastDone = now, t.Done
	d.mu.Unlock()
	d.emit(t)
}

// fail ends a transfer as failed, or as cancelled if the user stopped it.
func (d *Manager) fail(t *transfer, err error) {
	if t.ctx.Err() != nil {
		d.finish(t, "cancelled", nil)
		return
	}
	d.finish(t, "failed", err)
}

// finish moves t to a terminal state, optionally only when it is currently in one of `from`.
func (d *Manager) finish(t *transfer, state string, err error, from ...string) {
	d.mu.Lock()
	switch t.State {
	case "done", "failed", "cancelled", "rejected":
		d.mu.Unlock()
		return
	}
	if len(from) > 0 && !contains(from, t.State) {
		d.mu.Unlock()
		return
	}
	t.State = state
	t.Speed = 0
	if err != nil {
		t.Error = err.Error()
	}
	d.mu.Unlock()
	t.cancel()
	d.emit(t)
}

// emit sends a snapshot of the transfer to the UI.
func (d *Manager) emit(t *transfer) {
	d.mu.Lock()
	snap := t.Transfer
	d.mu.Unlock()
	d.hooks.Emit(snap)
}

// ---------- Protocol helpers ----------

// parseDCCSend parses "name ip port size [token]", including quoted names and IPv6.
func parseDCCSend(args string) (name string, ip net.IP, port int, size int64, token string, err error) {
	args = strings.TrimSpace(args)
	if strings.HasPrefix(args, `"`) {
		end := strings.Index(args[1:], `"`)
		if end < 0 {
			return "", nil, 0, 0, "", errMalformed
		}
		name, args = args[1:end+1], args[end+2:]
	} else {
		name, args, _ = strings.Cut(args, " ")
	}

	f := strings.Fields(args)
	if len(f) < 2 {
		return "", nil, 0, 0, "", errMalformed
	}

	if n, perr := strconv.ParseUint(f[0], 10, 32); perr == nil {
		ip = make(net.IP, 4)
		binary.BigEndian.PutUint32(ip, uint32(n))
	} else if ip = net.ParseIP(f[0]); ip == nil {
		return "", nil, 0, 0, "", errMalformed
	}

	port, err = strconv.Atoi(f[1])
	if err != nil || port < 0 || port > 65535 {
		return "", nil, 0, 0, "", errMalformed
	}
	if len(f) > 2 {
		size, _ = strconv.ParseInt(f[2], 10, 64)
	}
	if len(f) > 3 {
		token = f[3]
	}
	return name, ip, port, size, token, nil
}

// ctcpDCC builds the PRIVMSG that carries a DCC SEND offer.
func ctcpDCC(nick, name, ip string, port int, size int64, token string) string {
	line := fmt.Sprintf("PRIVMSG %s :\x01DCC SEND %s %s %d %d", nick, quoteName(name), ip, port, size)
	if token != "" {
		line += " " + token
	}
	return line + "\x01"
}

// quoteName wraps names that contain spaces in quotes.
func quoteName(name string) string {
	if strings.ContainsAny(name, " ") {
		return `"` + name + `"`
	}
	return name
}

// sendName is the wire form of a filename: no quotes or control characters.
func sendName(name string) string {
	return strings.Map(func(r rune) rune {
		if r < 32 || r == '"' {
			return '_'
		}
		return r
	}, name)
}

// sanitizeName strips paths and illegal characters so a peer cannot write outside Downloads.
func sanitizeName(name string) string {
	name = path.Base(strings.ReplaceAll(name, `\`, "/"))
	name = strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune(`<>:"/\|?*`, r) {
			return '_'
		}
		return r
	}, name)
	name = strings.Trim(name, ". ")
	if len(name) > 200 {
		name = name[:200]
	}
	if name == "" {
		name = "file"
	}
	return name
}

// encodeIP formats IPv4 as the legacy DCC integer and IPv6 as text.
func encodeIP(ip net.IP) string {
	if v4 := ip.To4(); v4 != nil {
		return strconv.FormatUint(uint64(binary.BigEndian.Uint32(v4)), 10)
	}
	return ip.String()
}

// acceptOne waits for one incoming connection, up to the timeout or until cancelled.
func acceptOne(ctx context.Context, ln net.Listener) (net.Conn, error) {
	defer ln.Close()
	stop := context.AfterFunc(ctx, func() { ln.Close() })
	defer stop()
	_ = ln.(*net.TCPListener).SetDeadline(time.Now().Add(dccWait))
	conn, err := ln.Accept()
	if err != nil && ctx.Err() == nil {
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			return nil, errNoConnect
		}
	}
	return conn, err
}

// dialPeer connects to the address the peer gave in its DCC offer or reply.
func dialPeer(t *transfer) (net.Conn, error) {
	return (&net.Dialer{Timeout: 20 * time.Second}).DialContext(t.ctx, "tcp", t.Peer)
}

// blockedThere explains a failed connection to the peer's port, with the mode to try instead.
func blockedThere(t *transfer, hint string) error {
	return fmt.Errorf("could not connect to %s at %s — their router or firewall blocks it; %s", t.Nick, t.Peer, hint)
}

// blockedHere explains a peer that never connected to our port, with the mode to try instead.
func blockedHere(err error, nick, hint string) error {
	if !errors.Is(err, errNoConnect) {
		return err
	}
	return fmt.Errorf("%s could not connect to you — your router or firewall blocks it; %s", nick, hint)
}

// createUnique creates name, or "name (1)", "name (2)"... without overwriting.
func createUnique(dir, name string) (*os.File, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for i := 0; i < 1000; i++ {
		n := name
		if i > 0 {
			n = fmt.Sprintf("%s (%d)%s", base, i, ext)
		}
		f, err := os.OpenFile(filepath.Join(dir, n), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		return f, err
	}
	return nil, errors.New("too many files with the same name")
}

// DownloadsDir returns ~/Downloads.
func DownloadsDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return os.TempDir()
	}
	return filepath.Join(home, "Downloads")
}

// randomToken makes the token that links a passive offer to its reply.
func randomToken() string {
	n, _ := rand.Int(rand.Reader, big.NewInt(1<<31))
	return n.String()
}

// contains reports whether s is in list.
func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
