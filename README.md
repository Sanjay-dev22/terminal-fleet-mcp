# terminal-fleet-mcp

An [MCP](https://modelcontextprotocol.io) server that lets one controlling AI agent session spawn and independently drive a **fleet of genuinely visible** Windows terminal windows — each can run its own program (including a second `claude` session), take its own instructions, and get read back independently — while a human watches every real window the whole time.

## The problem this solves

Most ways an AI agent can drive a terminal are **headless**: the agent spawns a process behind a pseudo-terminal (ConPTY / `node-pty`), types into it, and reports back what happened. That's fast and works well for scripted automation — but it gives a human nothing to look at. You're asked to trust that the agent did what it says it did, with no independent way to verify it in real time. See [`docs/motivation.md`](docs/motivation.md) for the original incident that motivated not hiding the terminal.

This project started from that idea and grew into its real purpose: **orchestrating several terminal/Claude Code sessions from one controlling session**, instead of a human manually opening a terminal, typing `claude`, enabling remote control, and repeating that per task. One session can spawn several labeled workers, give each its own task, and read each one's output independently to decide what to do next.

**The fix**: don't hide the terminal, and don't rely on window focus to control it. Spawn real, classic Windows console windows — the same kind you'd open yourself — and drive each one directly by process id, immune to whatever else is happening on screen.

## What it actually gives you

| Capability | Mechanism | Why it matters |
|---|---|---|
| **Spawn** a real terminal window | `Start-Process` (powershell/cmd/wsl, any command) | An actual OS window, not a virtual buffer — the user can see it exists |
| **Send** keystrokes | `WriteConsoleInput`, by pid | Writes directly into *that specific* console's own input buffer — never touches window focus or the shared system input queue, so it can't be misdelivered to whatever window the user happens to be using at the time |
| **Read** what's on screen | Win32 Console API (`AttachConsole` + `CONOUT$` + `ReadConsoleOutputCharacter`/`Attribute`) | Reads the actual character buffer the window is displaying — not a screenshot, not a guess, the same content the human sees. Can optionally annotate color (errors vs normal output) |
| **See** it, as an image | `PrintWindow` | Fallback for garbled text or layout-dependent TUIs |
| **Wait** for output | Polls the buffer for text or quiet | No more guessing sleep durations between send and read |
| **Track** a fleet | In-memory registry + labels | Every tool accepts a friendly label instead of a raw pid; `term_list` shows everything currently running |
| **Close** it | `Stop-Process` | Clean teardown when done |

Because reading goes through the real console buffer, the agent and the human are looking at **the same ground truth** — there's no second, hidden copy of "what happened" that only the agent has access to.

## Why not `SendKeys`/`SetForegroundWindow`?

An earlier version of this project drove input by stealing window focus and simulating keystrokes via Windows Forms `SendKeys`. That turned out to be fundamentally unsafe for the actual use case: it injects into the **shared, system-wide** input queue, routed by whichever window currently has OS focus — which races with anything else the user is doing (clicking another window, typing in a different terminal) and can silently misdeliver keystrokes to the wrong place. `WriteConsoleInput` writes directly into one specific console's own buffer, by pid, bypassing focus and that shared queue entirely — the target doesn't need to be visible, foreground, or even unminimized.

## Use cases

- **Orchestrating several Claude Code (or any CLI) sessions at once** — spawn N labeled terminals, give each its own task, read each independently, follow up based on what each one actually produced. The motivating case for this project.
- **Supervised automation of interactive CLIs** — anything that only shows its full behavior when it detects a real terminal (confirmation prompts, TUI pickers), with a human able to watch it happen.
- **Reproducing and debugging terminal-dependent bugs** that don't manifest the same way under a headless PTY, with a human verifying each step.
- **Teaching or demoing** what an agent is doing step by step, rather than presenting only a final summary.

## Requirements

- Windows (uses the Win32 Console API — this is not cross-platform)
- Node.js >= 18
- PowerShell available on `PATH`

## Installation

```bash
git clone https://github.com/Sanjay-dev22/terminal-fleet-mcp.git
cd terminal-fleet-mcp
npm install
```

## Using it as an MCP server

Register it with your MCP-compatible client. For Claude Code, add this to your `mcpServers` config (e.g. `~/.claude.json`):

```json
{
  "mcpServers": {
    "terminal-fleet": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/terminal-fleet-mcp/src/server.js"],
      "env": {}
    }
  }
}
```

Restart your MCP client, and seven tools become available. The server also declares [MCP `instructions`](https://modelcontextprotocol.io) — a usage guide (workflow, pacing, key syntax) that a compliant client surfaces to the agent automatically on connect, the same way tool descriptions are surfaced. You don't need to paste anything from this README into a prompt for the agent to know how to use the server correctly.

### `term_spawn`

Opens a new, visible terminal window, optionally running a command immediately and/or tagged with a friendly label.

| Param | Type | Required | Description |
|---|---|---|---|
| `shell` | `powershell` \| `cmd` \| `wsl` | no | Which shell hosts the window. Default `powershell` |
| `command` | string | no | Run immediately after the shell starts, e.g. `"claude"` or `"claude --resume <uuid>"` |
| `cwd` | string | no | Working directory |
| `label` | string | no | A friendly name to use instead of the pid in later calls |
| `env` | object | no | Extra environment variables for the spawned shell |

Returns `{ pid, label }`.

### `term_send`

Sends input directly into a terminal's own console input buffer, by pid — not by simulating a keyboard.

| Param | Type | Required | Description |
|---|---|---|---|
| `pid` | string | yes | Pid or label |
| `text` | string | no | Literal text, delivered as one atomic block regardless of length/content |
| `enter` | boolean | no | Press Enter after text/keys |
| `keys` | string[] | no | Key combos in order, e.g. `["CTRL+C"]`, `["UP","UP","ENTER"]`, `["CTRL+SHIFT+P"]`, `["ALT+F4"]`. Named keys: `ENTER ESC TAB UP DOWN LEFT RIGHT HOME END PGUP PGDN DELETE BACKSPACE INSERT BREAK F1-F12`, or a single letter/digit, combined with `CTRL`/`ALT`/`SHIFT` via `+` |

### `term_read`

Reads exactly what's currently rendered in the window via the real Windows Console API.

| Param | Type | Required | Description |
|---|---|---|---|
| `pid` | string | yes | Pid or label |
| `withColor` | boolean | no | Annotate colored text runs inline as `[RED]...[/RED]` etc |
| `extraScrollback` | number | no | Also read this many lines of buffer history above the visible window |

### `term_wait`

Blocks until a terminal's output contains specific text, goes idle, or times out — instead of guessing a sleep duration.

| Param | Type | Required | Description |
|---|---|---|---|
| `pid` | string | yes | Pid or label |
| `forText` | string | no | Substring, or `/regex/` |
| `idleMs` | number | no | Stop once unchanged for this long. Default 1500ms if `forText` not given |
| `timeoutMs` | number | no | Default 30000 |

### `term_screenshot`

Captures an actual PNG of the window via `PrintWindow`, for when `term_read`'s text doesn't make sense.

### `term_list`

Lists every terminal this server is tracking: pid, label, shell, command, cwd, alive/dead.

### `term_close`

Terminates a terminal's process.

## Examples

```bash
npm run example:basic              # spawn -> send -> read -> list -> close
npm run example:menu-navigation    # key combos: history recall via UP/UP, CTRL+C
npm run example:fleet              # the actual headline use case: two labeled workers, driven independently
```

## Known limitations

- **Windows only.** The console-reading/writing mechanism is Win32-specific.
- **Reads text, not pixels (by default).** `term_read` returns the character buffer; use `term_screenshot` for a true image.
- **Can't reach an IDE's own integrated terminal panel** (e.g. VS Code's) directly — this controls independent OS-level console windows, not IDE panels.
- **CTRL+C doesn't reliably abort a program mid-blocking-call.** It's delivered as a real keystroke (the console visibly echoes `^C`, confirming it arrived), which reliably interrupts most interactive programs reading it from their input stream. It does **not** reliably raise the OS-level break *signal* a program like a bare PowerShell `Read-Host` specifically waits for — Windows has no supported way to raise that signal targeted at an unrelated, already-running process from the outside. If a worker is truly stuck there, `term_close` and respawn rather than expecting `CTRL+C` to free it.

## License

[MIT](LICENSE)
