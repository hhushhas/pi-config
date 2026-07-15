import {
  isBashToolResult,
  isToolCallEventType,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

export const DEFAULT_FOREGROUND_BASH_TIMEOUT_SECONDS = 180;
export const FOREGROUND_TIMEOUT_RETRY_HINT =
  "For intentionally long work, ask the user to run /enable-bg-terminal if bg_start is unavailable, then retry with bg_start so it can run without a runtime timeout.";

export function applyDefaultBashTimeout(input: {
  command: string;
  timeout?: number;
}): void {
  if (input.timeout === undefined) {
    input.timeout = DEFAULT_FOREGROUND_BASH_TIMEOUT_SECONDS;
  }
}

export function addBackgroundRetryHint(text: string): string {
  if (!/Command timed out after \d+(?:\.\d+)? seconds/.test(text)) return text;
  if (text.includes(FOREGROUND_TIMEOUT_RETRY_HINT)) return text;
  return `${text}\n\n${FOREGROUND_TIMEOUT_RETRY_HINT}`;
}

/**
 * Keep Pi's built-in Bash implementation intact and only patch its invocation
 * at the supported tool-call boundary. That preserves Pi's output capture and
 * native timeout cleanup in parent and Pi-backed child sessions.
 */
export default function foregroundBashPolicy(pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) return;
    applyDefaultBashTimeout(event.input);
  });

  pi.on("tool_result", (event) => {
    if (!isBashToolResult(event) || !event.isError) return;
    const content = event.content.map((part) => {
      if (part.type !== "text") return part;
      const text = addBackgroundRetryHint(part.text);
      return text === part.text ? part : { ...part, text };
    });
    if (content.every((part, index) => part === event.content[index])) return;
    return { content };
  });
}
