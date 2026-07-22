/**
 * OpenCode-style Plan & Build Modes for Pi
 *
 * Toggle between Plan mode (read-only analysis/planning) and Build mode
 * (full implementation access) using SHIFT+TAB.
 *
 * - Plan mode: read-only tools, planning-focused system prompt, blocks edits
 * - Build mode: full tool access, implementation-focused system prompt
 *
 * Configure per-mode models in:
 *   ~/.pi/agent/opencode-modes.json  (user global)
 *   .pi/opencode-modes.json          (project-local, takes precedence)
 *
 * Example config:
 *   {
 *     "plan": {
 *       "model": "opencode/deepseek-v4-flash-free",
 *       "thinkingLevel": "max"
 *     },
 *     "build": {
 *       "model": "opencode/deepseek-v4-flash-free",
 *       "thinkingLevel": "off"
 *     }
 *   }
 *
 * Usage:
 *   SHIFT+TAB — toggle between Plan and Build modes
 *   /plan     — switch to Plan mode
 *   /build    — switch to Build mode
 *   /mode     — show current mode
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key, type AutocompleteItem } from "@earendil-works/pi-tui";

// ─── Constants ────────────────────────────────────────────────────────────

const MODE_PLAN = "plan" as const;
const MODE_BUILD = "build" as const;
type Mode = typeof MODE_PLAN | typeof MODE_BUILD;

// Config file names
const USER_CONFIG_FILE = join(getAgentDir(), "opencode-modes.json");
const PROJECT_CONFIG_NAME = "opencode-modes.json";

// Tools available in each mode
const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls", "subagent"];
const BUILD_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "subagent"];

// Write tools blocked in Plan mode
const WRITE_TOOLS = new Set(["edit", "write"]);

// All tools this extension manages (so we don't interfere with custom tools)
const MANAGED_TOOLS = new Set([...PLAN_TOOLS, ...BUILD_TOOLS]);

// Thinking level cycle order (skipping minimal and max for quick toggling)
const THINKING_LEVELS = ["off", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

// Destructive bash patterns blocked in Plan mode
const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

// ─── Plan Mode System Prompt ──────────────────────────────────────────────

const PLAN_SYSTEM_PROMPT = `You are in **PLAN MODE** — read-only analysis and planning.

**Your role:** Deeply understand the problem, explore the codebase, and create
a clear, actionable plan before any code is written.

**Rules:**
- You CANNOT edit or write files. The edit, write, and destructive bash tools
  are disabled.
- Read files thoroughly. Use offset/limit to navigate, but ensure you get
  complete understanding.
- Explore broadly: grep for related code, find similar patterns, understand
  architecture and data flow.
- Ask clarifying questions when requirements are ambiguous.
- Identify risks, edge cases, dependencies, and testing needs.

**Expected output:**
Create a structured numbered plan under a "## Plan" header:

## Plan
1. **Step one** — what to change, why, and potential risks
2. **Step two** — files to modify, approach
3. **Step three** — tests or validation needed

**Do NOT make any changes.** When your plan is ready, the user will switch to
Build mode to implement it.`;

// ─── Type Guards ──────────────────────────────────────────────────────────

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

// ─── Config ───────────────────────────────────────────────────────────────

interface ModeConfig {
	/** Provider/model string like "opencode/deepseek-v4-flash-free" */
	model?: string;
	/** Thinking level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" */
	thinkingLevel?: string;
}

interface OpenCodeModesConfig {
	plan?: ModeConfig;
	build?: ModeConfig;
}

function loadConfig(cwd: string): OpenCodeModesConfig {
	const configs: OpenCodeModesConfig[] = [];

	// User global config (lowest priority)
	if (existsSync(USER_CONFIG_FILE)) {
		try {
			const raw = readFileSync(USER_CONFIG_FILE, "utf-8");
			configs.push(JSON.parse(raw));
		} catch {
			// ignore malformed config
		}
	}

	// Project-local config (highest priority)
	const projectConfig = join(cwd, CONFIG_DIR_NAME, PROJECT_CONFIG_NAME);
	if (existsSync(projectConfig)) {
		try {
			const raw = readFileSync(projectConfig, "utf-8");
			configs.push(JSON.parse(raw));
		} catch {
			// ignore malformed config
		}
	}

	// Merge: later configs override earlier ones
	const merged: OpenCodeModesConfig = {};
	for (const c of configs) {
		if (c.plan) merged.plan = { ...merged.plan, ...c.plan };
		if (c.build) merged.build = { ...merged.build, ...c.build };
	}
	return merged;
}

// ─── Utilities ────────────────────────────────────────────────────────────

function uniqueTools(tools: string[]): string[] {
	return [...new Set(tools)];
}

function getPlanTools(activeTools: string[]): string[] {
	return uniqueTools([
		...activeTools.filter((name) => !WRITE_TOOLS.has(name)),
		...PLAN_TOOLS,
	]);
}

function getBuildTools(activeTools: string[]): string[] {
	return uniqueTools([
		...BUILD_TOOLS,
		...activeTools.filter((name) => !MANAGED_TOOLS.has(name)),
	]);
}

// ─── Extension ────────────────────────────────────────────────────────────

export default function openCodeModes(pi: ExtensionAPI): void {
	let currentMode: Mode = MODE_BUILD;
	let toolsBeforeMode: string[] | undefined;
	let config: OpenCodeModesConfig = {};

	// Per-mode model tracking (persisted as "provider/modelId" strings)
	const modeModels: Partial<Record<Mode, string>> = {};

	// Flag to distinguish config-driven model changes from user-driven ones
	let _applyingConfigModel = false;

	// Per-mode thinking level tracking
	const modeThinkingLevels: Partial<Record<Mode, string>> = {};

	// Flag to distinguish config-driven thinking level changes from user-driven ones
	let _applyingConfigThinking = false;

	// ── Flag ────────────────────────────────────────────────────────────────

	pi.registerFlag("mode", {
		description: 'Start in a specific mode: "plan" or "build" (default)',
		type: "string",
		default: "build",
	});

	// ── Status Updates ──────────────────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext): void {
		if (currentMode === MODE_PLAN) {
			ctx.ui.setStatus(
				"opencode-mode",
				ctx.ui.theme.fg("warning", "⏸ PLAN"),
			);
		} else {
			ctx.ui.setStatus(
				"opencode-mode",
				ctx.ui.theme.fg("success", "▶ BUILD"),
			);
		}
	}

	// ── Tool Management ─────────────────────────────────────────────────────

	function applyPlanTools(): void {
		if (toolsBeforeMode === undefined) {
			toolsBeforeMode = pi.getActiveTools();
		}
		pi.setActiveTools(getPlanTools(toolsBeforeMode));
	}

	function applyBuildTools(): void {
		pi.setActiveTools(
			toolsBeforeMode ?? getBuildTools(pi.getActiveTools()),
		);
		toolsBeforeMode = undefined;
	}

	// ── State Persistence ───────────────────────────────────────────────────

	function persistState(): void {
		pi.appendEntry("opencode-mode-state", {
			mode: currentMode,
			toolsBeforeMode,
			modeModels: Object.fromEntries(Object.entries(modeModels)),
			modeThinkingLevels: Object.fromEntries(Object.entries(modeThinkingLevels)),
		});
	}

	// ── Model Switching ──────────────────────────────────────────────────────

	async function applyModeModel(mode: Mode, ctx: ExtensionContext): Promise<void> {
		const modeConfig = mode === MODE_PLAN ? config.plan : config.build;
		if (!modeConfig) return;

		// Switch model if configured
		if (modeConfig.model) {
			const parts = modeConfig.model.split("/", 2);
			const provider = parts[0];
			const modelId = parts[1] ?? parts[0];

			const model = ctx.modelRegistry.find(provider, modelId);
			if (model) {
				_applyingConfigModel = true;
				const success = await pi.setModel(model);
				_applyingConfigModel = false;
				if (!success) {
					ctx.ui.notify(
						`No API key available for ${modeConfig.model} (${mode} mode)`,
						"error",
					);
				}
			} else {
				ctx.ui.notify(
					`Model "${modeConfig.model}" not found for ${mode} mode`,
					"error",
				);
			}
		}

		// Switch thinking level if configured
		if (modeConfig.thinkingLevel) {
			_applyingConfigThinking = true;
			pi.setThinkingLevel(modeConfig.thinkingLevel as any);
			_applyingConfigThinking = false;
		}
	}

	// ── Mode Switch ─────────────────────────────────────────────────────────

	async function setMode(mode: Mode, ctx: ExtensionContext): Promise<void> {
		if (mode === currentMode) return;

		// Save departing mode's current model and thinking level
		if (ctx.model) {
			modeModels[currentMode] = `${ctx.model.provider}/${ctx.model.id}`;
		}
		modeThinkingLevels[currentMode] = pi.getThinkingLevel();

		currentMode = mode;

		if (mode === MODE_PLAN) {
			applyPlanTools();
			ctx.ui.notify("⏸ Plan mode — read-only analysis. Write tools disabled.");
		} else {
			applyBuildTools();
			ctx.ui.notify("▶ Build mode — full tool access for implementation.");
		}

		// Restore model for arriving mode, or apply config default
		const storedModelId = modeModels[mode];
		if (storedModelId) {
			const [provider, modelId] = storedModelId.split("/", 2);
			const model = ctx.modelRegistry.find(provider, modelId);
			if (model) {
				await pi.setModel(model);
			} else {
				// Stored model no longer available — apply config default
				await applyModeModel(mode, ctx);
			}
		} else {
			await applyModeModel(mode, ctx);
		}

		// Always save what was actually set for this mode
		if (ctx.model) {
			modeModels[mode] = `${ctx.model.provider}/${ctx.model.id}`;
		}

		// Restore thinking level for arriving mode, or apply config default
		const storedThinking = modeThinkingLevels[mode];
		if (storedThinking) {
			_applyingConfigThinking = true;
			pi.setThinkingLevel(storedThinking as any);
			_applyingConfigThinking = false;
		} else {
			const modeConfig = mode === MODE_PLAN ? config.plan : config.build;
			if (modeConfig?.thinkingLevel) {
				_applyingConfigThinking = true;
				pi.setThinkingLevel(modeConfig.thinkingLevel as any);
				_applyingConfigThinking = false;
			}
		}
		// Always save what was actually set for this mode
		modeThinkingLevels[mode] = pi.getThinkingLevel();

		updateStatus(ctx);
		updateThinkingStatus(ctx);
		persistState();
	}

	function toggleMode(ctx: ExtensionContext): void {
		setMode(currentMode === MODE_PLAN ? MODE_BUILD : MODE_PLAN, ctx);
	}

	// ── System Prompt Injection ─────────────────────────────────────────────

	pi.on("before_agent_start", async () => {
		if (currentMode !== MODE_PLAN) return; // Build mode = Pi's natural state, no extra prompt

		return {
			message: {
				customType: "opencode-mode-context",
				content: PLAN_SYSTEM_PROMPT,
				display: false,
			},
		};
	});

	// ── Tool Call Filtering (Plan mode only) ────────────────────────────────

	pi.on("tool_call", async (event) => {
		if (currentMode !== MODE_PLAN) return;

		// Block write tools
		if (WRITE_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: `Plan mode: "${event.toolName}" is disabled. Use SHIFT+TAB or /build to switch to Build mode.`,
			};
		}

		// Block destructive bash commands
		if (event.toolName === "bash") {
			const command = event.input.command as string;
			const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
			if (isDestructive) {
				return {
					block: true,
					reason: `Plan mode: destructive bash command blocked. Switch to Build mode (SHIFT+TAB or /build) to make changes.\nCommand: ${command}`,
				};
			}
		}
	});

	// ── Model change tracking ──────────────────────────────────────────────

	pi.on("model_select", async (event) => {
		// Save user-initiated model changes (skip config-driven changes)
		if (!_applyingConfigModel && event.model) {
			modeModels[currentMode] = `${event.model.provider}/${event.model.id}`;
		}
	});

	// ── Thinking level change tracking ───────────────────────────────────────

	pi.on("thinking_level_select", async (event, ctx) => {
		updateThinkingStatus(ctx);
		// Save user-initiated changes (skip config-driven changes)
		if (!_applyingConfigThinking && event.level) {
			modeThinkingLevels[currentMode] = event.level;
		}
	});

	// ── Clean up stale mode context when not active ─────────────────────────

	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "opencode-mode-context") return true; // Keep our own
				if (msg.customType === "plan-mode-context") return false; // Strip old plan-mode
				if (msg.customType === "plan-execution-context") return false;
				if (msg.customType === "plan-complete") return false;
				if (msg.customType === "plan-todo-list") return false;
				if (msg.customType === "plan-mode-execute") return false;
				return true;
			}),
		};
	});

	// ── Commands ────────────────────────────────────────────────────────────

	pi.registerCommand("plan", {
		description: "Switch to Plan mode (read-only analysis)",
		handler: async (_args, ctx) => {
			if (currentMode === MODE_PLAN) {
				ctx.ui.notify("Already in Plan mode", "info");
				return;
			}
			setMode(MODE_PLAN, ctx);
		},
	});

	pi.registerCommand("build", {
		description: "Switch to Build mode (full implementation)",
		handler: async (_args, ctx) => {
			if (currentMode === MODE_BUILD) {
				ctx.ui.notify("Already in Build mode", "info");
				return;
			}
			setMode(MODE_BUILD, ctx);
		},
	});

	pi.registerCommand("mode", {
		description: "Show current mode",
		handler: async (_args, ctx) => {
			const modeLabel = currentMode === MODE_PLAN ? "⏸ Plan" : "▶ Build";
			const modelLabel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
			ctx.ui.notify(`Current mode: ${modeLabel} | Model: ${modelLabel}`, "info");
		},
	});

	// ── Thinking Level ──────────────────────────────────────────────────────

	function cycleThinking(ctx: ExtensionContext): void {
		const current = pi.getThinkingLevel();
		const idx = THINKING_LEVELS.indexOf(current as ThinkingLevel);
		const next = THINKING_LEVELS[(idx + 1) % THINKING_LEVELS.length];
		pi.setThinkingLevel(next);
		ctx.ui.notify(`Thinking level: ${next}`, "info");
		updateThinkingStatus(ctx);
	}

	function updateThinkingStatus(ctx: ExtensionContext): void {
		const level = pi.getThinkingLevel();
		ctx.ui.setStatus("opencode-thinking", `🧠 ${level}`);
	}

	pi.registerShortcut("alt+t", {
		description: "Cycle thinking level",
		handler: async (ctx) => {
			cycleThinking(ctx);
		},
	});

	pi.registerCommand("thinking", {
		description: "Set thinking level (off/low/medium/high/xhigh) or show current",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = THINKING_LEVELS.map((l) => ({
				value: l,
				label: l,
			}));
			if (!prefix) return items;
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			if (!args || !(THINKING_LEVELS as readonly string[]).includes(args)) {
				ctx.ui.notify(`Current thinking level: ${pi.getThinkingLevel()}`, "info");
				return;
			}
			pi.setThinkingLevel(args as ThinkingLevel);
			ctx.ui.notify(`Thinking level: ${args}`, "info");
			updateThinkingStatus(ctx);
		},
	});

	// ── Shortcut: SHIFT+TAB ─────────────────────────────────────────────────

	pi.registerShortcut(Key.shift("tab"), {
		description: "Toggle between Plan and Build modes",
		handler: async (ctx) => {
			toggleMode(ctx);
		},
	});

	// ── Session lifecycle ───────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// Load config
		config = loadConfig(ctx.cwd);

		// Check CLI flag
		const flagMode = pi.getFlag("mode") as string | undefined;
		if (flagMode === MODE_PLAN || flagMode === MODE_BUILD) {
			currentMode = flagMode;
		}

		// Restore persisted state
		const entries = ctx.sessionManager.getEntries();
		const stateEntry = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "opencode-mode-state",
			)
			.pop() as {
				data?: {
					mode?: Mode;
					toolsBeforeMode?: string[];
					modeModels?: Record<string, string>;
					modeThinkingLevels?: Record<string, string>;
				};
			} | undefined;

		if (stateEntry?.data) {
			const restored = stateEntry.data;
			if (restored.mode === MODE_PLAN || restored.mode === MODE_BUILD) {
				currentMode = restored.mode;
			}
			if (restored.toolsBeforeMode) {
				toolsBeforeMode = restored.toolsBeforeMode;
			}
			if (restored.modeModels) {
				for (const [key, val] of Object.entries(restored.modeModels)) {
					if (key === MODE_PLAN || key === MODE_BUILD) {
						modeModels[key] = val;
					}
				}
			}
			if (restored.modeThinkingLevels) {
				for (const [key, val] of Object.entries(restored.modeThinkingLevels)) {
					if (key === MODE_PLAN || key === MODE_BUILD) {
						modeThinkingLevels[key] = val;
					}
				}
			}
		}

		// Apply tools for current mode
		if (currentMode === MODE_PLAN) {
			applyPlanTools();
		} else {
			applyBuildTools();
		}

		// Apply per-mode model on initial load
		if (currentMode === MODE_PLAN || currentMode === MODE_BUILD) {
			const storedModelId = modeModels[currentMode];
			if (storedModelId && ctx.modelRegistry) {
				const [provider, modelId] = storedModelId.split("/", 2);
				const model = ctx.modelRegistry.find(provider, modelId);
				if (model) {
					_applyingConfigModel = true;
					await pi.setModel(model);
					_applyingConfigModel = false;
				} else {
					// Stored model no longer available — apply config default
					await applyModeModel(currentMode, ctx);
				}
			} else {
				await applyModeModel(currentMode, ctx);
			}

			// Always save what was actually set for this mode
			if (ctx.model) {
				modeModels[currentMode] = `${ctx.model.provider}/${ctx.model.id}`;
			}
		}

		// Apply per-mode thinking level on initial load
		if (currentMode === MODE_PLAN || currentMode === MODE_BUILD) {
			const storedThinking = modeThinkingLevels[currentMode];
			if (storedThinking) {
				_applyingConfigThinking = true;
				pi.setThinkingLevel(storedThinking as any);
				_applyingConfigThinking = false;
			} else {
				const modeConfig = currentMode === MODE_PLAN ? config.plan : config.build;
				if (modeConfig?.thinkingLevel) {
					_applyingConfigThinking = true;
					pi.setThinkingLevel(modeConfig.thinkingLevel as any);
					_applyingConfigThinking = false;
				}
			}
		}

		updateStatus(ctx);
		updateThinkingStatus(ctx);
	});
}
