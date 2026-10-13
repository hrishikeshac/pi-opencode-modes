# Pi OpenCode Modes

Toggle between **Plan mode** (read-only analysis) and **Build mode** (full implementation) in [Pi](https://github.com/earendil-works/pi-coding-agent), inspired by OpenCode's Plan/Build workflow.

Press **`Shift+Tab`** to switch modes. (`Alt+M` is also registered, but many terminals never forward Option/Meta — on macOS Option+M types `µ` — so it is only a convenience alias.)

## Features

| Feature | Plan Mode ⏸ | Build Mode ▶ |
|---------|------------|-------------|
| Tools | read, grep, find, ls, bash (read-only allowlist) | read, bash, edit, write, grep, find, ls, subagent |
| Write tools (edit/write) | Blocked | Full access |
| `subagent` | Blocked (spawns a separate, ungated pi process) | Full access |
| Bash | Read-only allowlist, deny by default | Full access |
| System prompt | Planning & analysis focused | Implementation & execution focused |
| Per-mode model | Configurable, persists per mode | Configurable, persists per mode |
| Thinking level | `Alt+T` to cycle, `/think` to set | `Alt+T` to cycle, `/think` to set |

## Installation

1. Copy the extension to Pi's global extensions directory:
   ```bash
   cp opencode-modes.ts ~/.pi/agent/extensions/
   ```

2. Reload Pi: `/reload`

> **Note:** mode toggling uses `Shift+Tab`, which Pi binds to its built-in `app.thinking.cycle` by default. Rebind that first so the two don't collide:
> ```json
> { "app.thinking.cycle": ["ctrl+shift+t"] }
> ```
> (This extension's own `Alt+T` covers thinking cycling, so rebinding loses nothing.)
> `Alt+M` is registered as an alias, but **do not rely on it**: herdr and most terminal setups do not forward `alt+` combinations, and on macOS Option+M produces `µ`.

## Usage

| Action | Command / Shortcut |
|--------|-------------------|
| Toggle mode | `Shift+Tab` (alias: `Alt+M`) |
| Switch to Plan | `/plan` |
| Switch to Build | `/build` |
| Show current mode + model | `/mode` |
| Cycle thinking level | `Alt+T` |
| Set thinking level | `/think [off/minimal/low/medium/high/xhigh/max]` |
| Show thinking level | `/think` (no args) |
| Start in Plan mode | `pi --mode plan` |

### Persistence

Model (`/model`) and thinking level (`Alt+T` / `/think`) choices are remembered per mode. Switching modes and back restores your previous selections, and they survive session restarts. You can skip config files entirely and just use interactive commands.

## Optional: Initial defaults per mode

If you want different starting model/thinking level the first time you enter each mode, create `~/.pi/agent/opencode-modes.json`:

```json
{
  "plan": {
    "model": "opencode/deepseek-v4-flash-free",
    "thinkingLevel": "max"
  },
  "build": {
    "model": "opencode/deepseek-v4-flash-free",
    "thinkingLevel": "off"
  }
}
```

Config values are applied **at session start**, so editing this file takes effect on your next session. Within a session, interactive changes (`/model`, `Alt+T`, `/think`) win and are remembered across mode switches. You can skip this file entirely.

Project-local configs at `.pi/opencode-modes.json` merge on top of the global one.

## How it works

This is a Pi extension (`opencode-modes.ts`) placed in `~/.pi/agent/extensions/`. It uses the Pi ExtensionAPI to:

- **Intercept tool calls** — blocks `edit`/`write`/`subagent` and non-allowlisted bash in Plan mode
- **Manage tools** — switches the active toolset via `pi.setActiveTools()`
- **Inject system prompts** — appends mode-specific instructions to the turn's system prompt, so nothing accumulates in the session
- **Switch models** — calls `pi.setModel()` when a per-mode model is configured; remembers your manual model choice per mode
- **Cycle thinking** — `Alt+T` to cycle thinking levels, `/think` command for direct setting
- **Status display** — shows current mode, model, and thinking level in the status bar
- **Keyboard shortcuts** — registers `Shift+Tab` (mode toggle, with `Alt+M` alias) and `Alt+T` (thinking cycle)

Zero external dependencies — only depends on the Pi core APIs (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`).

## Caveats

The Plan mode bash filter is a **guardrail against accidents, not a security sandbox**. It denies by default and allowlists read-only commands, but tools like `awk` and `sed -n` are still capable of writing files. Treat Plan mode as a way to avoid unintended edits, not as a boundary you can rely on against a hostile prompt.

## License

MIT
