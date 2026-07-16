import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
export const SETTINGS_DIR = path.join(AGENT_DIR, "auto-name");
export const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json");

export interface AutoNameSettings {
	/** Model identifier in "provider/model-id" format */
	modelId?: string;
	/** Thinking/reasoning level for name generation */
	thinkingLevel?: ThinkingLevel;
}

const DEFAULT_SETTINGS: AutoNameSettings = {};

function loadRaw(): AutoNameSettings {
	try {
		const data = fs.readFileSync(SETTINGS_FILE, "utf-8");
		const parsed = JSON.parse(data) as unknown;
		if (parsed && typeof parsed === "object") {
			return parsed as AutoNameSettings;
		}
	} catch {
		// Missing or invalid settings use defaults.
	}
	return { ...DEFAULT_SETTINGS };
}

export function loadSettings(): AutoNameSettings {
	return loadRaw();
}

export function saveSettings(settings: AutoNameSettings): void {
	fs.mkdirSync(SETTINGS_DIR, { recursive: true });
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf-8");
}

export function getSetting<K extends keyof AutoNameSettings>(key: K): AutoNameSettings[K] {
	return loadRaw()[key];
}

export function setSetting<K extends keyof AutoNameSettings>(key: K, value: AutoNameSettings[K]): void {
	const settings = loadRaw();
	if (value === undefined) {
		delete settings[key];
	} else {
		settings[key] = value;
	}
	saveSettings(settings);
}

/** Format settings for the interactive command. */
export function formatSettings(settings: AutoNameSettings): string {
	const lines: string[] = [];
	lines.push(`Model: ${settings.modelId ?? "default (current session model)"}`);
	lines.push(`Thinking: ${settings.thinkingLevel ?? "default (minimal)"}`);
	return lines.join("\n");
}
