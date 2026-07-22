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
| Per-mode model | Configurable | Configurable |

## Installation

1. Copy the extension to Pi's global extensions directory:
   ```bash
   cp opencode-modes.ts ~/.pi/agent/extensions/
   ```

2. Bind `app.thinking.cycle` away from `Shift+Tab` (or it conflicts). Add to `~/.pi/agent/keybindings.json`:
   ```json
   {
     "app.thinking.cycle": ["ctrl+shift+t"]
   }
   ```

3. Reload Pi: `/reload`

## Configuration

Create `~/.pi/agent/opencode-modes.json` to set per-mode models and thinking levels:

```json
{
  "plan": {
    "model": "opencode/deepseek-v4-flash-free",
    "thinkingLevel": "high"
  },
  "build": {
    "model": "opencode/deepseek-v4-flash-free",
    "thinkingLevel": "high"
  }
}
```

The `model` field uses the `provider/model-id` format — any registered model works:

```json
{
  "plan": {
    "model": "opencode/deepseek-v4-flash-free"
  },
  "build": {
    "model": "anthropic/claude-sonnet-4-5",
    "thinkingLevel": "high"
  }
}
```

Project-local configs at `.pi/opencode-modes.json` merge on top of the global one, so you can override models per repository.

## Usage

| Action | Command / Shortcut |
|--------|-------------------|
| Toggle mode | `Shift+Tab` |
| Switch to Plan | `/plan` |
| Switch to Build | `/build` |
| Show current mode | `/mode` |
| Start in Plan mode | `pi --mode plan` |

## How it works

This is a Pi extension (`opencode-modes.ts`) placed in `~/.pi/agent/extensions/`. It uses the Pi ExtensionAPI to:

- **Intercept tool calls** — blocks `edit`/`write` and destructive bash in Plan mode
- **Manage tools** — switches the active toolset via `pi.setActiveTools()`
- **Inject system prompts** — injects mode-specific instructions before each turn
- **Switch models** — calls `pi.setModel()` when a per-mode model is configured
- **Keyboard shortcut** — registers `Shift+Tab` via `pi.registerShortcut()`

Zero external dependencies — only depends on the Pi core APIs (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`).

## License

MIT
