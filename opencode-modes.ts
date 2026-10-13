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
 * Config values are applied at session start, so editing the file takes effect
 * on the next session. Within a session, /think, ALT+T and model changes win.
 *
 * Usage:
 *   SHIFT+TAB — toggle between Plan and Build modes
 *   ALT+M     — toggle alias (terminals that forward Option/Meta only)
 *   /plan     — switch to Plan mode
 *   /build    — switch to Build mode
 *   /mode     — show current mode
 *   /think    — set thinking level (off/minimal/low/medium/high/xhigh/max)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
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

// Tools available in each mode.
// "subagent" is deliberately absent from PLAN_TOOLS: it spawns a separate pi
// process with its own (write-capable) tools, which this extension cannot gate.
const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls"];
const BUILD_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "subagent"];

// Tools blocked in Plan mode.
// "subagent" must be listed here as well as omitted from PLAN_TOOLS: a tool that
// is already active survives the filter below, so omission alone would not
// disable it when arriving from Build mode.
const PLAN_MODE_BLOCKED_TOOLS = new Set(["edit", "write", "subagent"]);

// All tools this extension manages (so we don't interfere with custom tools)
const MANAGED_TOOLS = new Set([...PLAN_TOOLS, ...BUILD_TOOLS]);

// Full ladder accepted by /think (same order pi uses internally)
const ALL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof ALL_THINKING_LEVELS)[number];

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
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[\s\d;|&])>(?!>|&)/, // redirect to file (not "->", "=>" or "2>&1")
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|restore|clean|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
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
	/\bfind\b[^|;]*-delete\b/i,
	/\bsed\b[^|;]*-i\b/i,
	/\|\s*(sudo\s+)?(sh|bash|zsh|dash|ksh|python[0-9.]*|node|perl|ruby|php)\b/i,
];

// Read-only allowlist for Plan mode. A command must match one of these AND
// match no destructive pattern above; anything else is denied. This is a
// guardrail against accidents, not a security sandbox.
const SAFE_PATTERNS = [
	/^\s*cat\b/, /^\s*head\b/, /^\s*tail\b/, /^\s*less\b/, /^\s*more\b/,
	/^\s*grep\b/, /^\s*find\b/, /^\s*ls\b/, /^\s*pwd\b/, /^\s*echo\b/,
	/^\s*printf\b/, /^\s*wc\b/, /^\s*sort\b/, /^\s*uniq\b/, /^\s*diff\b/,
	/^\s*file\b/, /^\s*stat\b/, /^\s*du\b/, /^\s*df\b/, /^\s*tree\b/,
	/^\s*which\b/, /^\s*whereis\b/, /^\s*type\b/, /^\s*env\b/, /^\s*printenv\b/,
	/^\s*uname\b/, /^\s*whoami\b/, /^\s*id\b/, /^\s*date\b/, /^\s*cal\b/,
	/^\s*uptime\b/, /^\s*ps\b/, /^\s*top\b/, /^\s*htop\b/, /^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/, /^\s*sed\s+-n/i, /^\s*awk\b/, /^\s*rg\b/, /^\s*fd\b/,
	/^\s*bat\b/, /^\s*eza\b/,
];

function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
	return !isDestructive && isSafe;
}

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

// ─── Build Mode System Prompt ─────────────────────────────────────────────

const BUILD_SYSTEM_PROMPT = `You are in **BUILD MODE** — implementation and execution.

**Your role:** Implement the plan with focused, correct changes. You have full
tool access including edit, write, and bash.

**Rules:**
- Keep scope tight. Do exactly what was asked, no more.
- Read files before editing to understand current state.
- Make surgical edits. Prefer edit over write for existing files.
- Explain your reasoning briefly before each change.
- Run tests or type checks after changes if the project supports them.
- If you encounter unexpected complexity, STOP and explain rather than
  hacking around it.

**After completing changes:**
- Summarize what was done.
- Note any follow-up work or tests that should be added.`;

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

// Split "provider/modelId" on the FIRST slash only, so ids that themselves
// contain slashes (e.g. "openrouter/anthropic/claude-sonnet") survive intact.
function splitModelId(ref: string): { provider: string; modelId: string } {
	const i = ref.indexOf("/");
	if (i === -1) return { provider: ref, modelId: ref };
	return { provider: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

function getPlanTools(activeTools: string[]): string[] {
	return uniqueTools([
		...activeTools.filter((name) => !PLAN_MODE_BLOCKED_TOOLS.has(name)),
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

	// What each mode *asked* for (never clamped) so the status can show clamping.
	// modeThinkingLevels holds the effective level; this holds the request.
	const modeThinkingRequests: Partial<Record<Mode, string>> = {};

	// What the model actually did on the last assistant message. pi reports the level
	// it requested; this reports observed thinking output, so "high (no thinking
	// emitted)" and "off (emitting thinking)" become visible instead of guessed.
	let lastThinkingObserved: "unknown" | "thinking" | "silent" = "unknown";

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
			const { provider, modelId } = splitModelId(modeConfig.model);

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
			modeThinkingRequests[mode] = modeConfig.thinkingLevel;
			_applyingConfigThinking = true;
			pi.setThinkingLevel(modeConfig.thinkingLevel as any);
			_applyingConfigThinking = false;
		}
	}

	// ── Mode Switch ─────────────────────────────────────────────────────────

	// Model switches are async, so a rapid double-toggle would otherwise start
	// two overlapping switches and leave the live model out of sync with the
	// mode shown in the status line. Serialise them instead, coalescing any
	// toggle that arrives mid-switch so the last request always wins.
	let switching = false;
	let pendingMode: Mode | undefined;

	async function setMode(mode: Mode, ctx: ExtensionContext): Promise<void> {
		if (switching) {
			pendingMode = mode;
			return;
		}
		switching = true;
		try {
			let target: Mode | undefined = mode;
			while (target !== undefined) {
				// Skip a request that the in-flight switch already landed on.
				if (target !== currentMode) await applyMode(target, ctx);
				target = pendingMode;
				pendingMode = undefined;
			}
		} finally {
			switching = false;
			pendingMode = undefined;
		}
	}

	async function applyMode(mode: Mode, ctx: ExtensionContext): Promise<void> {
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
			const { provider, modelId } = splitModelId(storedModelId);
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
		const modeConfig = mode === MODE_PLAN ? config.plan : config.build;
		if (modeConfig?.thinkingLevel) modeThinkingRequests[mode] = modeConfig.thinkingLevel;
		if (storedThinking) {
			_applyingConfigThinking = true;
			pi.setThinkingLevel(storedThinking as any);
			_applyingConfigThinking = false;
		} else if (modeConfig?.thinkingLevel) {
			_applyingConfigThinking = true;
			pi.setThinkingLevel(modeConfig.thinkingLevel as any);
			_applyingConfigThinking = false;
		}
		// Always save what was actually set for this mode
		modeThinkingLevels[mode] = pi.getThinkingLevel();

		updateStatus(ctx);
		updateThinkingStatus(ctx);
		persistState();
	}

	async function toggleMode(ctx: ExtensionContext): Promise<void> {
		await setMode(currentMode === MODE_PLAN ? MODE_BUILD : MODE_PLAN, ctx);
	}

	// ── System Prompt Injection ─────────────────────────────────────────────

	pi.on("before_agent_start", async (event) => {
		const prompt = currentMode === MODE_PLAN
			? PLAN_SYSTEM_PROMPT
			: BUILD_SYSTEM_PROMPT;

		// Append to this turn's system prompt instead of injecting a persistent
		// message: nothing is written to the session, so repeated turns cannot
		// accumulate copies of the mode prompt in the context.
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});

	// ── Tool Call Filtering (Plan mode only) ────────────────────────────────

	pi.on("tool_call", async (event) => {
		if (currentMode !== MODE_PLAN) return;

		// Block write tools
		if (PLAN_MODE_BLOCKED_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: `Plan mode: "${event.toolName}" is disabled. Use SHIFT+TAB or /build to switch to Build mode.`,
			};
		}

		// Bash is allowlisted: read-only commands only, deny by default.
		if (event.toolName === "bash") {
			const command = event.input.command as string;
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Plan mode: command blocked (not a read-only allowlisted command). Switch to Build mode (SHIFT+TAB or /build) to make changes.\nCommand: ${command}`,
				};
			}
		}
	});

	// ── Model change tracking ──────────────────────────────────────────────

	pi.on("model_select", async (event, ctx) => {
		// Save user-initiated model changes (skip config-driven changes)
		if (!_applyingConfigModel && event.model) {
			modeModels[currentMode] = `${event.model.provider}/${event.model.id}`;
		}
		// The new model clamps the thinking level, and may not support thinking at all.
		// thinking_level_select only fires when the level changes, so refresh here too.
		lastThinkingObserved = "unknown";
		updateThinkingStatus(ctx);
	});

	// ── Thinking level change tracking ───────────────────────────────────────

	pi.on("thinking_level_select", async (event, ctx) => {
		updateThinkingStatus(ctx);
		// Save user-initiated changes (skip config-driven changes).
		// event.level is already clamped by pi, so request == effective here.
		if (!_applyingConfigThinking && event.level) {
			modeThinkingLevels[currentMode] = event.level;
			modeThinkingRequests[currentMode] = event.level;
		}
	});

	// ── Clean up stale mode context when not active ─────────────────────────

	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				// Strip mode context persisted by older versions (and any left
				// behind in resumed sessions); we no longer inject messages.
				if (msg.customType === "opencode-mode-context") return false;
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
			await setMode(MODE_PLAN, ctx);
		},
	});

	pi.registerCommand("build", {
		description: "Switch to Build mode (full implementation)",
		handler: async (_args, ctx) => {
			if (currentMode === MODE_BUILD) {
				ctx.ui.notify("Already in Build mode", "info");
				return;
			}
			await setMode(MODE_BUILD, ctx);
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

	// Replicates pi's rule for levels a model advertises. Non-reasoning models
	// only support "off"; xhigh/max need explicit thinkingLevelMap entries.
	function supportedThinkingLevels(model: ExtensionContext["model"]): string[] {
		if (!model?.reasoning) return ["off"];
		const map = (model as { thinkingLevelMap?: Record<string, string | null | undefined> } | undefined)?.thinkingLevelMap;
		return ALL_THINKING_LEVELS.filter((level) => {
			const mapped = map?.[level];
			if (mapped === null) return false;
			if (level === "xhigh" || level === "max") return mapped !== undefined;
			return true;
		});
	}

	pi.on("agent_start", async () => {
		// Reset observation for the new turn
		lastThinkingObserved = "unknown";
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const msg = event.message as AssistantMessage;
		const hasThinkingBlocks = msg.content.some((b) => b.type === "thinking" && b.thinking.length > 0);
		const reasoningTokens = ((msg.usage as { reasoning?: number } | undefined)?.reasoning ?? 0) > 0;
		lastThinkingObserved = hasThinkingBlocks || reasoningTokens ? "thinking" : "silent";
		updateThinkingStatus(ctx);
	});

	function thinkingStatus(ctx: ExtensionContext): string {
		const level = pi.getThinkingLevel();
		const supportsReasoning = !!ctx.model?.reasoning;
		const requested = modeThinkingRequests[currentMode] ?? (currentMode === MODE_PLAN ? config.plan?.thinkingLevel : config.build?.thinkingLevel);
		const parts: string[] = [];
		let tone: "success" | "warning" | "dim" = level === "off" ? "dim" : "success";

		if (!supportsReasoning) {
			parts.push("🧠 off", "(model reasoning:false)");
			tone = "warning";
		} else {
			parts.push(`🧠 ${level}`);
			if (requested && requested !== level) {
				parts.push(`⟵${requested}`);
				tone = "warning";
			}
			if (level !== "off" && lastThinkingObserved === "silent") {
				parts.push("(no thinking emitted)");
				tone = "warning";
			} else if (level === "off" && lastThinkingObserved === "thinking") {
				parts.push("(model thinking anyway)");
				tone = "warning";
			}
		}

		const text = parts.join(" ");
		return ctx.ui.theme.fg(tone, text);
	}

	function cycleThinking(ctx: ExtensionContext): void {
		const levels = supportedThinkingLevels(ctx.model);
		const current = pi.getThinkingLevel();
		let idx = levels.indexOf(current);
		if (idx === -1) idx = 0;
		const next = levels[(idx + 1) % levels.length] as ThinkingLevel;
		pi.setThinkingLevel(next);
		const applied = pi.getThinkingLevel();
		if (applied !== next) {
			ctx.ui.notify(`Thinking level requested: ${next} → clamped by model to ${applied}`, "warning");
		} else {
			ctx.ui.notify(`Thinking level: ${applied}`, "info");
		}
		updateThinkingStatus(ctx);
	}

	function updateThinkingStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("opencode-thinking", thinkingStatus(ctx));
	}

	pi.registerShortcut("alt+t", {
		description: "Cycle thinking level",
		handler: async (ctx) => {
			cycleThinking(ctx);
		},
	});

	pi.registerCommand("think", {
		description: "Set thinking level (off/minimal/low/medium/high/xhigh/max) or show current status",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = ALL_THINKING_LEVELS.map((l) => ({
				value: l,
				label: l,
			}));
			if (!prefix) return items;
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			if (!args || !(ALL_THINKING_LEVELS as readonly string[]).includes(args)) {
				const current = pi.getThinkingLevel();
				const requested = modeThinkingRequests[currentMode] ?? "none";
				const supported = supportedThinkingLevels(ctx.model).join("/");
				const reasoningFlag = ctx.model?.reasoning ? "true" : "false";
				ctx.ui.notify(
					`Thinking level: ${current} (requested: ${requested}) | Model supported: ${supported} (reasoning: ${reasoningFlag}) | Last turn observed: ${lastThinkingObserved}`,
					"info",
				);
				return;
			}
			pi.setThinkingLevel(args as ThinkingLevel);
			const applied = pi.getThinkingLevel();
			if (applied !== args) {
				ctx.ui.notify(`Requested thinking level "${args}" → model clamped to "${applied}"`, "warning");
			} else {
				ctx.ui.notify(`Thinking level set to: ${applied}`, "info");
			}
			updateThinkingStatus(ctx);
		},
	});

	// ── Shortcut: SHIFT+TAB ─────────────────────────────────────────────────

	// SHIFT+TAB is the primary binding. Pi binds shift+tab to app.thinking.cycle
	// by default, so rebind that first (see README). ALT+M is registered as an
	// alias because many terminals never forward Option/Meta (on macOS Option+M
	// is "µ"), so it cannot be relied on as the primary.
	const toggleModeShortcut = async (ctx: ExtensionContext): Promise<void> => {
		await toggleMode(ctx);
	};
	pi.registerShortcut(Key.shift("tab"), {
		description: "Toggle between Plan and Build modes",
		handler: toggleModeShortcut,
	});
	pi.registerShortcut("alt+m", {
		description: "Toggle between Plan and Build modes (alias)",
		handler: toggleModeShortcut,
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

		// Apply per-mode model and thinking level on initial load.
		//
		// The config file wins at session start, so editing it takes effect on
		// the next session; persisted state is only a fallback for modes the
		// config does not mention. Within a session, /think, ALT+T and model
		// changes still win and are remembered across mode switches.
		const modeConfig = currentMode === MODE_PLAN ? config.plan : config.build;

		if (modeConfig?.model) {
			await applyModeModel(currentMode, ctx);
		} else {
			const storedModelId = modeModels[currentMode];
			if (storedModelId && ctx.modelRegistry) {
				const { provider, modelId } = splitModelId(storedModelId);
				const model = ctx.modelRegistry.find(provider, modelId);
				if (model) {
					_applyingConfigModel = true;
					await pi.setModel(model);
					_applyingConfigModel = false;
				}
			}
		}

		const thinkingToApply = modeConfig?.thinkingLevel ?? modeThinkingLevels[currentMode];
		if (thinkingToApply) {
			_applyingConfigThinking = true;
			pi.setThinkingLevel(thinkingToApply as any);
			_applyingConfigThinking = false;
		}

		updateStatus(ctx);
		updateThinkingStatus(ctx);
	});
}
