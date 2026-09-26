# irsee architecture

irsee is a desktop IRC client. It has two parts:

- **Backend (Go):** owns the network. It handles sockets, TLS, the IRC protocol, reconnecting, file transfers, and settings on disk.
- **Frontend (HTML/CSS/JS):** owns everything the user sees. It keeps channels, nick lists, and message history, and draws the UI.

[Wails](https://wails.io) connects the two parts. It opens a native window that uses the operating system's built-in webview, loads the frontend into it, and lets JavaScript call Go methods. Go sends events back to JavaScript. There is no HTTP server and no bundled browser.

```
┌──────────────────────────── one process: irsee ──────────────────────────────┐
│                                                                              │
│   Go backend  (backend/)                   Frontend in OS webview (frontend/)│
│                                                                              │
│   ┌──────────┐  lines   ┌─────────┐  batched "irc" events  ┌──────────────┐  │
│   │ Client   │ ───────► │  App    │ ─────────────────────► │   app.js     │  │
│   │ (1/server│          │ (bridge)│                        │ state + UI   │  │
│   │  socket) │ ◄─────── │         │ ◄───────────────────── │              │  │
│   └──────────┘  Send()  └─────────┘   window.go.backend.   └──────────────┘  │
│        ▲                   │  ▲        App.Connect/Send/…         ▲          │
│        │ TLS/TCP           │  │                                   │          │
│   IRC server          ┌────┴──┴─┐                          commands.js       │
│                       │   DCC   │ ◄─► peer (file transfer)  format.js        │
│                       └─────────┘                                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Folder layout

```
irsee/
├── main.go                  Entry point: embeds frontend/ into the binary and calls backend.Run
├── wails.json               Wails project config (no npm install/build steps)
├── go.mod / go.sum          Go module "irsee" and its dependencies
│
├── backend/                 All Go code
│   ├── run.go               Creates the window and binds App to JavaScript
│   ├── app.go               App: the only thing the UI calls; wires the packages below together
│   ├── irc/
│   │   ├── client.go        One IRC server connection (dial, TLS, CAP, SASL, reconnect, flood control)
│   │   └── message.go       IRC line parser (IRCv3 tags, prefix, command, params)
│   ├── dcc/
│   │   └── dcc.go           DCC SEND file transfers (send/receive, active/passive)
│   ├── config/
│   │   └── config.go        Load/save config.json
│   ├── stats/
│   │   └── stats.go         CPU / RAM / network numbers for the status bar
│   └── netcount/
│       └── netcount.go      Byte counter wrapped around every socket
│
├── frontend/                Everything shown in the window (served as-is, no build step)
│   ├── index.html           Page skeleton: sidebar, messages, input, nick list, status bar
│   ├── css/style.css        All styling, dark + light theme
│   └── js/
│       ├── app.js           Main UI: state, IRC event handling, rendering, dialogs, keys
│       ├── commands.js      Catalog of IRC commands for the palette + /slash command parser
│       └── format.js        mIRC colors/bold/italic → DOM, and clickable links
│
├── build/                   Output of `wails build` (bin/) + generated files (ignored)
└── .github/workflows/       CI that builds macOS, Windows and Linux
```

## Backend (Go)

### Package dependencies

```
main ──► backend (App) ──┬──► irc ──────► netcount
                         ├──► dcc ──────► netcount
                         ├──► stats ────► netcount
                         └──► config ───► irc (for ServerConfig)
```

Only `backend` imports Wails. The packages under it know nothing about the UI or about each other, apart from `config` using `irc.ServerConfig` and everyone using `netcount`. Each package reports back through callbacks that `app.go` supplies:

- `irc` uses `irc.Handler{Message, State, DCC}`.
- `dcc` uses `dcc.Hooks{Send, IP, Emit}`.

This means `irc` and `dcc` have no import cycle, and each can be used or tested on its own.

### `main.go` → `backend/run.go`
`main.go` exists because Go needs a `main` package, and `//go:embed` can only include folders next to it. It embeds `frontend/`, strips the folder prefix, and passes the files to `backend.Run`. `Run` builds the Wails window options: size, background, startup and shutdown hooks. It then binds the `App` object, so every exported `App` method can be called from JavaScript as `window.go.backend.App.<Method>()`.

### `backend/app.go`: the bridge
`App` is the only object the UI talks to. It holds a map `server id → *irc.Client`, a `*dcc.Manager`, and a `*stats.Sampler`. Most methods are thin wrappers that call into a package.

| Method | Goes to | What it does |
| --- | --- | --- |
| `Connect(cfg)` | `irc` | Creates an `irc.Client` with a `Handler` that turns its callbacks into `Event`s, then starts it. If a client already exists for that id, it replaces the old one. |
| `Disconnect(id, reason)` | `irc` | Sends QUIT and removes the client, so it will not reconnect. |
| `Send(id, line)` | `irc` | Queues a raw IRC line on that server's client. |
| `LoadConfig` / `SaveConfig` | `config` | Reads and writes `config.json`. |
| `DCCSendFile` / `DCCAccept` | `dcc` | Opens the native file or save dialog (Wails), then calls `Manager.Send` or `Manager.Accept`. |
| `DCCCancel` / `DCCReveal` / `DCCClear` | `dcc` | Cancels, shows a file in its folder, or clears finished transfers. |
| `Stats` | `stats` | Returns one sample for the status bar. |
| `startup` / `shutdown` | Wails | Starts the event pump. On shutdown, sends QUIT to every server. |

**Event pump (`pump`).** Packages never call into the UI directly. Their callbacks push `Event`s into a buffered channel. `pump` collects events for 25 ms (or until 1000 are waiting) and sends them as one `EventsEmit("irc", batch)`. During a flood, such as a 5000-name NAMES reply, a big MOTD, or a 50k-channel LIST, the UI gets a few large updates instead of thousands of small ones.

Each event has a `kind`:
- `msg`: a parsed IRC message
- `state`: connecting, registered, reconnecting, or disconnected
- `dcc`: a file transfer update

Events from a replaced (old) client are dropped, so a late "disconnected" from the old connection cannot overwrite the new one.

`dccIP` also lives here, because it needs both the server config and the live socket. It returns the "DCC address" setting if one is set, otherwise the local address of the IRC socket.

### `backend/irc/client.go`: one server connection
Each `Client` runs its own goroutines:

```
run()  ── loop ──►  session()  ── on drop ──►  wait (1s, 2s, 4s … max 60s)  ──► session() …
                       │
                       ├─ writer()   takes lines from the send queue; token bucket: burst 8, then 2 lines/s
                       ├─ pinger()   PING every 90s; the read deadline is 240s, so dead links are detected
                       └─ read loop  one line at a time → ParseMessage → handle() → Handler.Message
```

- **Registration:** `session` dials TCP and wraps the socket with `netcount.Wrap`. If TLS is on, it runs the TLS handshake. Then it sends `CAP LS 302`, `PASS`, `NICK`, and `USER`.
- **`handle`** answers protocol messages itself, without involving the UI:
  - `PING` → `PONG`
  - CAP negotiation: requests the IRCv3 caps we support
  - SASL PLAIN: `AUTHENTICATE`
  - Nick already in use during registration: retries with `nick_`
  - Tracks our own nick
  - Sends `DCC` CTCP messages to `Handler.DCC`
  
  It returns `true` for lines the UI should not see.
- **Sending:** `Send` pushes lines into a queue, and `writer` applies the rate limit. `write` is the direct path for urgent protocol replies (PONG, CAP, SASL), which must not wait behind a paste.
- **Stopping:** `Stop` closes the `stop` channel, writes QUIT, and closes the socket. `run` sees the closed channel and exits instead of reconnecting.
- `ServerConfig` (one saved server, which the UI also edits) is defined here.

### `backend/irc/message.go`: parser
`ParseMessage` turns `@tags :nick!user@host COMMAND p1 p2 :trailing` into a `Message` struct. It:

- unescapes IRCv3 tag values
- uses the `server-time` tag for the message timestamp when present
- decodes lines that are not valid UTF-8 as Latin-1, so text from old clients is still readable

### `backend/dcc/dcc.go`: file transfers
`Manager` keeps a list of `transfer`s. Each transfer has a state:
`offered → connecting/waiting → active → done | failed | cancelled | rejected`

- **Incoming offer.** The IRC client sees `PRIVMSG me :\x01DCC SEND name ip port size [token]\x01`, and `app.go` passes it to `Manager.Handle`. The transfer is created in the `offered` state and shown in the UI. Nothing happens until the user presses Accept.
- **Accept.** `Accept(id, path)` writes to the path the user chose. If there is no path, it uses `createUnique` in Downloads, which never overwrites an existing file. `sanitizeName` has already removed any path from the name. `receive` then either connects to the sender (active mode) or opens a port and replies with it (passive mode). It streams bytes to disk and sends a 4-byte ack after each read, which the DCC protocol requires.
- **Send.** `Send(server, nick, path, passive)`:
  - **Active mode:** `sendListen` opens a random port, sends the offer with `Hooks.IP`, and waits for the peer to connect.
  - **Passive mode:** we offer port 0 with a random token. When the peer replies with its own port and the same token, `sendConnect` connects to it.
  
  `sendStream` then writes the file and waits for the final ack.
- **Cancel.** Each transfer has a `context`. Cancelling it closes the socket or listener immediately. `finish` makes the first terminal state stick, so a later error cannot overwrite it.
- **Progress** updates reach the UI (`Hooks.Emit`) at most 4 times per second per transfer.

### `backend/config/config.go`: settings on disk
`Load` and `Save` handle `<OS config dir>/irsee/config.json`. The write is atomic (tmp file + rename) and the file mode is 0600, because the file contains passwords in plain text.

### `backend/stats/stats.go`: status bar numbers
`Sampler.Sample()` runs each time the UI polls `App.Stats` (every 2 seconds while the window is visible). It returns:

- CPU and RSS for our own process, plus child processes. This includes the webview on Windows and Linux. On macOS, WebKit runs outside our process tree, so it is not counted.
- Go heap size and goroutine count
- System CPU and RAM (via gopsutil)
- Network rate, from the `netcount` totals

### `backend/netcount/netcount.go`: traffic counter
`Wrap(conn)` returns a connection that adds every byte read or written to two global atomic counters. The IRC and DCC sockets are wrapped, and `Totals()` gives the stats sampler the raw numbers.

## Frontend (JavaScript)

The frontend is plain ES modules with no framework and no build step. The source you edit is exactly what is shipped.

### `js/app.js`: the main UI
The file is split into sections, in this order:

1. **State.** `S.servers` maps a server id to `{cfg, status, nick, isupport, buffers}`. A *buffer* is one window in the sidebar: the server buffer, a channel, or a query. It holds `lines`, `users` (the nick list), `topic`, the unread count, and join state. Buffer keys are lowercased with IRC casemapping, so `#Go` and `#go` are the same buffer.
2. **Render scheduling.** Nothing redraws directly. Code calls `dirty('side' | 'bar' | 'nicks' | 'msgs' | 'full' | 'list' | 'xfer')`, and one `requestAnimationFrame` redraws only the parts that changed. New lines for the active buffer are appended as a DOM fragment. They are not a full re-render.
3. **Rendering.** `renderSidebar`, `renderBar` (title and topic), `renderMessages` / `appendPending` (message list, capped at 3000 lines), and `renderNicks` (sorted by prefix rank, then name).
4. **IRC events.** `EventsOn('irc')` receives each batch. Each event goes to `onState` (connect, reconnect, and rejoining channels), `onTransfer` (DCC), or `onMessage`. `onMessage` routes PRIVMSG, NOTICE, JOIN, PART, KICK, QUIT, NICK, MODE, TOPIC and the others into the right buffer. `onNumeric` handles numeric replies: ISUPPORT (prefixes and channel types), topics, NAMES, LIST, WHOIS, and errors. `applyModes` keeps nick prefixes (@, +) correct.
5. **File transfers.** `onTransfer`, the Files dialog (`openTransfers`), and `sendFile`.
6. **Sending.** `send` calls Go's `Send`, then echoes your own PRIVMSG or NOTICE into the buffer. Passwords sent to *Serv bots are masked in the echo. `runResult` executes what a command produced: raw lines, open a buffer, quit, open a dialog, or start a DCC send. `submit` handles the input box: plain text, `/commands`, multi-line paste, and splitting long messages at 400 bytes.
7. **Connections and config.** `saveConfig`, `connect`, `disconnect`, `closeBuffer`, `removeServer`. Joined channels are written to the config automatically (`remember`), so they are rejoined on the next start.
8. **Modals.** The command palette (`openPalette` → `openCommandForm`), the server editor (`openServerDialog`), and the channel browser (`openListDialog`).
9. **Context menus.** Right-click menus for nicks, buffers, and servers.
10. **Input.** History, Tab completion, and global keyboard shortcuts. Links open in the system browser through `BrowserOpenURL`.
11. **Status bar.** `pollStats` calls `Stats()` every 2 seconds and updates the bottom bar.
12. **Boot.** Loads the config, creates the servers, and auto-connects. If no servers exist, it opens "Add server".

### `js/commands.js`: what the user can send
- **`COMMANDS`** is the palette catalog. Each entry has a group, a name, a description, form `fields` (with defaults such as the current channel), and a `build(values)` function. `build` returns the raw IRC line(s) or an action.
- **`parseSlash`** turns `/kick bob spam` into the same kind of result. Unknown `/foo bar` is sent as `FOO bar`.
- Helpers: `massMode` splits `/op a b c d` into several MODE lines with at most 3 modes each, and `banMask` turns `bob` into `bob!*@*`.

Both paths produce the same result shape, so `runResult` in `app.js` is the single place where commands are executed.

### `js/format.js`: rendering IRC text
- **`render(text, parent)`** walks the mIRC control codes (bold, italic, underline, colors, reverse, reset) and builds spans. It turns URLs into links.
- It only creates text nodes and never uses `innerHTML`, so nothing a server sends can inject HTML or scripts.
- **`strip`** removes the codes. It is used for highlights, topics in tooltips, and the channel list.

## Flow of one message

**Incoming:** `server → socket → Client read loop → ParseMessage → handle() (PING/CAP/DCC handled here) → App.events → pump (25 ms batch) → EventsEmit("irc") → app.js onMessage → buffer.lines → dirty('msgs') → next animation frame appends the DOM line`

**Outgoing:** `input box → submit() → parseSlash / plain text → runResult → send() → App.Send → Client queue → writer (rate limit) → socket`, and at the same time `send()` echoes your line into the buffer.

## Design choices

- **Why it stays lightweight:**
  - The OS webview is used instead of Chromium.
  - The frontend has no framework.
  - Events are sent in batches.
  - Only the changed parts of the UI are redrawn.
  - Message history is capped per buffer.
  - The status bar stops polling while the window is hidden.
- **Where the logic lives:**
  - Go handles only the transport and protocol plumbing.
  - All IRC meaning (who is in which channel, where a message belongs) is decided in `app.js`.
  
  That keeps one source of truth for state and a narrow bridge: 11 methods and 1 event name.
- **Security:**
  - IRC text is rendered only as text nodes.
  - DCC never auto-accepts and sanitizes filenames.
  - `config.json` is 0600 (passwords in it are plain text).
  - TLS verification is on unless the user turns it off per server.

## Adding things

- **A new command in the palette:** add an entry to `COMMANDS` in `frontend/js/commands.js`.
- **A new slash command:** add a `case` in `parseSlash` and the name to `SLASH_NAMES`, so Tab completion finds it.
- **Handling a new server reply:** add a `case` in `onMessage` (for named commands) or `onNumeric` (for numbers) in `app.js`.
- **A new Go method for the UI:** add an exported method on `App` in `backend/app.go`. Wails exposes it as `window.go.backend.App.Name()` after the next `wails build` or `wails dev`.
- **A new backend feature:** put it in its own package under `backend/`. Give it callbacks rather than importing `backend`, and wire it up in `NewApp`.
