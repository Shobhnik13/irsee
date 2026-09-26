// Package backend is the bridge between the UI and the IRC, DCC, config, and stats packages.
// Every exported method on App can be called from JavaScript as window.go.backend.App.<Method>().
package backend

import (
	"context"
	"errors"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"irsee/backend/config"
	"irsee/backend/dcc"
	"irsee/backend/irc"
	"irsee/backend/stats"
)

// Event is one update pushed to the UI; kind is "msg", "state", or "dcc".
type Event struct {
	Server string        `json:"server"`
	Kind   string        `json:"kind"`
	Msg    *irc.Message  `json:"msg,omitempty"`
	State  string        `json:"state,omitempty"`
	Nick   string        `json:"nick,omitempty"`
	Error  string        `json:"error,omitempty"`
	DCC    *dcc.Transfer `json:"dcc,omitempty"`
}

// App owns every live connection and forwards their events to the UI.
type App struct {
	ctx     context.Context
	mu      sync.Mutex
	clients map[string]*irc.Client
	events  chan Event
	dcc     *dcc.Manager
	stats   *stats.Sampler
}

// NewApp creates the app with no connections, a DCC manager, and a stats sampler.
func NewApp() *App {
	a := &App{clients: map[string]*irc.Client{}, events: make(chan Event, 4096), stats: stats.New()}
	a.dcc = dcc.New(dcc.Hooks{
		Send: a.Send,
		IP:   a.dccIP,
		Emit: func(t dcc.Transfer) { a.events <- Event{Server: t.Server, Kind: "dcc", DCC: &t} },
	})
	return a
}

// startup runs when the window opens and starts the event pump.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	go a.pump()
}

// shutdown sends QUIT to every server when the window closes.
func (a *App) shutdown(ctx context.Context) {
	a.mu.Lock()
	clients := a.clients
	a.clients = map[string]*irc.Client{}
	a.mu.Unlock()
	for _, c := range clients {
		c.Stop("irsee closed")
	}
}

// pump batches events so floods (NAMES, LIST, MOTD) cost one IPC call per frame instead of one per line.
func (a *App) pump() {
	var batch []Event
	var flush <-chan time.Time
	for {
		select {
		case <-a.ctx.Done():
			return
		case ev := <-a.events:
			batch = append(batch, ev)
			if flush == nil {
				flush = time.After(25 * time.Millisecond)
			}
			if len(batch) < 1000 {
				continue
			}
		case <-flush:
		}
		runtime.EventsEmit(a.ctx, "irc", batch)
		batch = nil
		flush = nil
	}
}

// ---------- IRC ----------

// Connect starts (or restarts) a connection for one server config.
func (a *App) Connect(cfg irc.ServerConfig) error {
	cfg.Host = strings.TrimSpace(cfg.Host)
	cfg.Nick = strings.TrimSpace(cfg.Nick)
	if cfg.ID == "" || cfg.Host == "" || cfg.Nick == "" {
		return errors.New("id, host and nick are required")
	}

	id := cfg.ID
	var c *irc.Client
	// Events from a client that has since been replaced are dropped.
	emit := func(ev Event) {
		if a.client(id) == c {
			a.events <- ev
		}
	}
	c = irc.NewClient(cfg, irc.Handler{
		Message: func(m *irc.Message) { emit(Event{Server: id, Kind: "msg", Msg: m}) },
		State: func(state, nick, errMsg string) {
			emit(Event{Server: id, Kind: "state", State: state, Nick: nick, Error: errMsg})
		},
		DCC: func(nick, text string, notice bool) { a.dcc.Handle(id, nick, text, notice) },
	})

	a.mu.Lock()
	old := a.clients[id]
	a.clients[id] = c
	a.mu.Unlock()

	if old != nil {
		old.Stop("Reconnecting")
	}
	c.Start()
	return nil
}

// Disconnect quits a server and stops reconnecting to it.
func (a *App) Disconnect(id, reason string) {
	a.mu.Lock()
	c := a.clients[id]
	delete(a.clients, id)
	a.mu.Unlock()

	if c != nil {
		c.Stop(reason)
		a.events <- Event{Server: id, Kind: "state", State: "disconnected"}
	}
}

// Send queues a raw IRC line for one server.
func (a *App) Send(id, line string) error {
	c := a.client(id)
	if c == nil {
		return errors.New("not connected")
	}
	return c.Send(line)
}

// client returns the live client for a server id, or nil.
func (a *App) client(id string) *irc.Client {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.clients[id]
}

// ---------- Config ----------

// LoadConfig reads saved servers from config.json.
func (a *App) LoadConfig() (config.Config, error) {
	return config.Load()
}

// SaveConfig writes servers to config.json.
func (a *App) SaveConfig(cfg config.Config) error {
	return config.Save(cfg)
}

// ---------- File transfers ----------

// DCCSendFile asks the user for a file and offers it to nick (active or passive).
func (a *App) DCCSendFile(server, nick string, passive bool) (string, error) {
	if a.client(server) == nil {
		return "", errors.New("not connected")
	}
	p, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{Title: "Send file to " + nick})
	if err != nil || p == "" {
		return "", err
	}
	return a.dcc.Send(server, nick, p, passive)
}

// DCCAccept accepts an incoming offer into Downloads, or asks where to save it when saveAs is true.
func (a *App) DCCAccept(id string, saveAs bool) error {
	path := ""
	if saveAs {
		t, ok := a.dcc.Get(id)
		if !ok {
			return errors.New("offer is no longer available")
		}
		p, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{Title: "Save " + t.Name, DefaultDirectory: dcc.DownloadsDir(), DefaultFilename: t.Name})
		if err != nil || p == "" {
			return err
		}
		path = p
	}
	return a.dcc.Accept(id, path)
}

// DCCCancel rejects an offer or stops a running transfer.
func (a *App) DCCCancel(id string) {
	a.dcc.Cancel(id)
}

// DCCReveal shows a finished file in Finder, Explorer, or the file manager.
func (a *App) DCCReveal(id string) error {
	return a.dcc.Reveal(id)
}

// DCCClear forgets finished transfers.
func (a *App) DCCClear() {
	a.dcc.Clear()
}

// dccIP is the address peers should connect to: the configured DCC host, else the local end of the IRC socket.
func (a *App) dccIP(id string) net.IP {
	c := a.client(id)
	if c == nil {
		return nil
	}
	if h := strings.TrimSpace(c.Config().DCCHost); h != "" {
		if ip := net.ParseIP(h); ip != nil {
			return ip
		}
		if ips, err := net.LookupIP(h); err == nil && len(ips) > 0 {
			return ips[0]
		}
	}
	return c.LocalIP()
}

// ---------- Status bar ----------

// Stats is polled by the UI every 2 seconds while the window is visible.
func (a *App) Stats() stats.Stats {
	return a.stats.Sample()
}
