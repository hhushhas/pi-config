import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Keeps skills manually invokable via /skill:name, but hides the ambient
// <available_skills> index from the model so it cannot auto-select skills.
export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    const stripped = event.systemPrompt
      .replace(/\n?<available_skills>[\s\S]*?<\/available_skills>\n?/g, "\n")
      .replace(/\n{3,}/g, "\n\n");

    if (stripped !== event.systemPrompt) {
      return { systemPrompt: stripped };
    }
  });
}
