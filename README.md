# irsee

A lightweight desktop IRC client for macOS, Windows, and Linux. It uses Go and [Wails](https://wails.io) and gives you a GUI for every common IRC command.

The app is a single native binary of about 10 MB. It uses the operating system's own webview (WebKit, WebView2, or WebKitGTK) instead of bundling Chromium. At idle, it uses about 85 MB of memory in total.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the code is organized.

## Features

- **Connections.** Multiple servers, TLS, SASL PLAIN, server password, and auto-reconnect with backoff. Client-side flood control prevents the server from disconnecting you when you paste many lines.
- **IRCv3.** Supports `server-time`, `multi-prefix`, `message-tags`, `away-notify`, `account-notify`, `extended-join`, `chghost`, and `invite-notify`.
- **Command palette.** Press `Ctrl/Cmd+K` to see every IRC command as a form, with a preview of the raw line. There are 65 commands grouped as Messaging, Channel, User, Server, Operator, Services, and CTCP. Use RAW for anything else.
- **Slash commands.** Supports `/join`, `/part`, `/msg`, `/query`, `/me`, `/notice`, `/nick`, `/topic`, `/kick`, `/kickban`, `/ban`, `/unban`, `/op`, `/deop`, `/voice`, `/devoice`, `/halfop`, `/mode`, `/invite`, `/whois`, `/away`, `/back`, `/list`, `/ctcp`, `/ns`, `/cs`, `/quit`, `/raw`, `/clear`, `/close`, and `/help`. Any unknown `/cmd args` is sent as `CMD args`.
- **Channel browser.** Shows the LIST results in a filterable table. Click a row to join the channel.
- **Nick list.** Nicks show their prefixes and are sorted by rank. Right-click a nick to Whois, Query, Op, Voice, Kick, Ban, or send a CTCP.
- **Channel list.** Joined channels are remembered and rejoined automatically on startup and after a reconnect.
- **File transfers (DCC SEND).** You can send and receive files in active or passive mode. To send, right-click a nick and choose **Send file…**, or type `/dcc send nick` (`/dcc psend nick` for passive). Every incoming file asks for Accept, Save as, or Reject; nothing downloads automatically. Accepted files go to `~/Downloads`, and an existing file with the same name is never overwritten. Incoming filenames are cleaned so they cannot write outside the target folder. The Files panel shows progress and speed, and lets you cancel a transfer or show a finished file in its folder.
- **Formatting.** mIRC colors and formatting are shown, links are clickable, and highlights are marked in the unread badges.

## Keys

| Key | Action |
| --- | --- |
| `Ctrl/Cmd+K` | Command palette |
| `Tab` | Complete a nick, channel, or /command |
| `↑` / `↓` | Input history |
| `Alt+↑` / `Alt+↓`, `Ctrl+Tab` | Previous / next window |
| `Ctrl/Cmd+1…9` | Jump to a window |
| `Shift+Enter` | New line (multi-line paste sends each line) |
| `PageUp` / `PageDown` | Scroll messages |
| `F11`, `Ctrl+Cmd+F` (macOS) | Toggle full screen |

## Build

Requirements: Go 1.25+ and the Wails CLI (`go install github.com/wailsapp/wails/v2/cmd/wails@latest`). No Node or npm is needed, because the frontend is plain HTML, CSS, and JS in `frontend/`.

```sh
wails build -trimpath -ldflags "-s -w"                              # native build for this OS
wails build -platform windows/amd64 -trimpath -ldflags "-s -w"      # Windows .exe (can be cross-built from macOS/Linux)
wails dev                                                           # live-reload dev mode
```

- **macOS:** requires the Xcode Command Line Tools. The output is `build/bin/irsee.app`.
- **Windows:** the output is `build/bin/irsee.exe`. It needs the WebView2 runtime, which Windows 10 and 11 already include.
- **Linux:** install `libgtk-3-dev` and `libwebkit2gtk-4.1-dev`, then build with `-tags webkit2_41`. Linux builds must run on Linux.

The GitHub Actions workflow in `.github/workflows/build.yml` builds all three platforms when you push a `v*` tag.

## DCC notes

- In **active** mode, the sender opens a port and the receiver connects to it. When you send from behind a home router, the other person usually cannot reach you. Use **passive** mode in that case (the receiver opens the port), or forward a port and set **DCC address** in the server settings to your public IP.
- The first time irsee listens on a port, macOS or Windows may ask you to allow incoming connections.
- The other person sees your IP address. DCC traffic is not encrypted.
- Resuming an interrupted transfer (DCC RESUME) and DCC CHAT are not supported yet.

## Settings

Settings are saved in `config.json` under the OS config directory. On macOS that is `~/Library/Application Support/irsee`, on Windows `%AppData%\irsee`, and on Linux `~/.config/irsee`. The file is readable only by your user account (mode 0600). Passwords are stored in plain text inside it.
