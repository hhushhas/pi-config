/**
 * Auto session name — detects purpose from first user message
 * and sets it as the session name via pi.setSessionName().
 *
 * - Auto-detect: uses pi-ai completeSimple() to summarize first message → pi.setSessionName()
 * - Footer display: shows session name in status bar via setStatus()
 * - Manual control: use built-in /name command (no custom command needed)
 * - Skips auto-detection for subagent sessions
 * - Configurable model / thinking level via /auto-name:setting
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildNameContext,
	extractNameFromResult,
	extractSessionFilePath,
	formatNameStatus,
	isSubagentSessionPath,
	NAME_SYSTEM_PROMPT,
} from "./utils/auto-name-utils.ts";
import { formatSettings, loadSettings, setSetting, type ThinkingLevel } from "./utils/settings.ts";
import { generateShortLabel } from "./utils/short-label.js";
import { NAME_STATUS_KEY } from "./utils/status-keys.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function isSubagentSession(ctx: ExtensionContext): boolean {
	const sessionFilePath = extractSessionFilePath(ctx.sessionManager);
	return isSubagentSessionPath(sessionFilePath);
}

function resolveModel(ctx: ExtensionContext) {
	const settings = loadSettings();
	if (settings.modelId) {
		const parts = settings.modelId.split("/");
		if (parts.length === 2) {
			const [provider, modelId] = parts;
			const m = ctx.modelRegistry.find(provider, modelId);
			if (m) return m;
		}
	}
	return ctx.model;
}

async function detectNameFromMessage(userMessage: string, ctx: ExtensionContext): Promise<string> {
	const settings = loadSettings();
	const model = resolveModel(ctx);
	if (!model) return "";

	return generateShortLabel(
		{ model, modelRegistry: ctx.modelRegistry },
		{
			systemPrompt: NAME_SYSTEM_PROMPT,
			prompt: buildNameContext(userMessage),
			reasoning: settings.thinkingLevel ?? "minimal",
			extractText: extractNameFromResult,
		},
	);
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function autoSessionName(pi: ExtensionAPI) {
	const updateTerminalTitle = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const cwdBasename = path.basename(process.cwd());
		const name = pi.getSessionName();
		if (!name) return;
		ctx.ui.setTitle(`π - ${name} - ${cwdBasename}`);
	};

	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;

		const name = pi.getSessionName();
		if (!name) {
			ctx.ui.setStatus(NAME_STATUS_KEY, undefined);
			return;
		}

		ctx.ui.setStatus(NAME_STATUS_KEY, formatNameStatus(name));
		updateTerminalTitle(ctx);
	};

	// ── Auto Name (async) ──────────────────────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		if (isSubagentSession(ctx)) return;

		// Skip sessions that already have a name.
		if (pi.getSessionName()) return;

		const text = event.prompt.trim();
		if (!text) return;

		// Detect and set the name without delaying the parent turn.
		(async () => {
			try {
				const detected = await detectNameFromMessage(text, ctx);
				if (detected && !pi.getSessionName()) {
					pi.setSessionName(detected);
					updateStatus(ctx);
				}
			} catch {
				// Naming is best-effort.
			}
		})();
	});

	// ── Command: /auto-name:setting ─────────────────────────────

	pi.registerCommand("auto-name:setting", {
		description: "Configure auto-name model and thinking level. Usage: /auto-name:setting [model|thinking] [value]",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const tokens = args.trim().split(/\s+/);
			const subCommand = tokens[0];

			// With no arguments, show current settings.
			if (!subCommand) {
				const settings = loadSettings();
				ctx.ui.notify(formatSettings(settings), "info");
				return;
			}

			if (subCommand === "model") {
				const modelId = tokens.slice(1).join(" ").trim();
				if (!modelId) {
					ctx.ui.notify(
						"Usage: /auto-name:setting model <provider/model-id> (for example, anthropic/claude-sonnet-4-20250514)",
						"warning",
					);
					return;
				}
				const parts = modelId.split("/");
				if (parts.length !== 2) {
					ctx.ui.notify('Model ID must use the provider/model-id format (for example, openai/gpt-4o).', "warning");
					return;
				}
				const [provider, id] = parts;
				const m = ctx.modelRegistry.find(provider, id);
				if (!m) {
					ctx.ui.notify(`Model not found: ${modelId}`, "error");
					return;
				}
				setSetting("modelId", modelId);
				ctx.ui.notify(`Auto-name model set: ${m.name} (${modelId})`, "info");
				return;
			}

			if (subCommand === "thinking") {
				const level = tokens[1]?.trim() as ThinkingLevel | undefined;
				const validLevels: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];
				if (!level || !validLevels.includes(level)) {
					ctx.ui.notify(`Usage: /auto-name:setting thinking <${validLevels.join("|")}>`, "warning");
					return;
				}
				setSetting("thinkingLevel", level);
				ctx.ui.notify(`Auto-name thinking level set: ${level}`, "info");
				return;
			}

			ctx.ui.notify(`Unknown setting: ${subCommand}. available: model, thinking`, "warning");
		},
	});

	// ── Lifecycle ─────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(NAME_STATUS_KEY, undefined);
	});
}
