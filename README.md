# Pi OpenCode Modes

Toggle between **Plan mode** (read-only analysis) and **Build mode** (full implementation) in [Pi](https://github.com/earendil-works/pi-coding-agent), inspired by OpenCode's Plan/Build workflow.

Press **`Shift+Tab`** to switch modes.

## Features

| Feature | Plan Mode ⏸ | Build Mode ▶ |
|---------|------------|-------------|
| Tools | read, grep, find, ls, bash (safe only), subagent | read, bash, edit, write, grep, find, ls, subagent |
| Write tools (edit/write) | Blocked | Full access |
| Destructive bash (rm, git write, etc.) | Blocked | Full access |
| System prompt | Planning & analysis focused | Implementation & execution focused |
| Per-mode model | Configurable, persists per mode | Configurable, persists per mode |
| Thinking level | `Alt+T` to cycle, `/thinking` to set | `Alt+T` to cycle, `/thinking` to set |

## Installation

1. Copy the extension to Pi's global extensions directory:
   ```bash
   cp opencode-modes.ts ~/.pi/agent/extensions/
   ```

2. Reload Pi: `/reload`

> **Note:** `Shift+Tab` is now used for mode toggling. To avoid conflicts, make sure Pi's built-in `app.thinking.cycle` is not bound to `Shift+Tab`. If needed, rebind it via `~/.pi/agent/keybindings.json`:
> ```json
> { "app.thinking.cycle": ["ctrl+shift+t"] }
> ```
> Or use the built-in `Alt+T` shortcut this extension provides.

## Usage

| Action | Command / Shortcut |
|--------|-------------------|
| Toggle mode | `Shift+Tab` |
| Switch to Plan | `/plan` |
| Switch to Build | `/build` |
| Show current mode + model | `/mode` |
| Cycle thinking level | `Alt+T` |
| Set thinking level | `/thinking [off/low/medium/high/xhigh]` |
| Show thinking level | `/thinking` (no args) |
| Start in Plan mode | `pi --mode plan` |

### Persistence

Model (`/model`) and thinking level (`Alt+T` / `/thinking`) choices are remembered per mode. Switching modes and back restores your previous selections. Selections survive session restarts. You can skip config files entirely and just use interactive commands.

## Optional: Initial defaults per mode

If you want different starting model/thinking level the first time you enter each mode, create `~/.pi/agent/opencode-modes.json`:

```json
{
  "plan": {
    "model": "opencode/deepseek-v4-flash-free",
    "thinkingLevel": "high"
  },
  "build": {
    "model": "anthropic/claude-sonnet-4-5",
    "thinkingLevel": "low"
  }
}
```

Once you change model or thinking level interactively (`/model`, `Alt+T`, `/thinking`), that choice sticks and overrides the config. You can skip this file entirely.

Project-local configs at `.pi/opencode-modes.json` merge on top of the global one.

## How it works

This is a Pi extension (`opencode-modes.ts`) placed in `~/.pi/agent/extensions/`. It uses the Pi ExtensionAPI to:

- **Intercept tool calls** — blocks `edit`/`write` and destructive bash in Plan mode
- **Manage tools** — switches the active toolset via `pi.setActiveTools()`
- **Inject system prompts** — injects mode-specific instructions before each turn
- **Switch models** — calls `pi.setModel()` when a per-mode model is configured; remembers your manual model choice per mode
- **Cycle thinking** — `Alt+T` to cycle thinking levels, `/thinking` command for direct setting
- **Status display** — shows current mode, model, and thinking level in the status bar
- **Keyboard shortcuts** — registers `Shift+Tab` (mode toggle) and `Alt+T` (thinking cycle)

Zero external dependencies — only depends on the Pi core APIs (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`).

## License

MIT
