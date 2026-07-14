import { existsSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ImageParams = Type.Object({
  prompt: Type.String({ description: "A complete description of the image to generate." }),
  outputPath: Type.Optional(
    Type.String({
      description: "Optional PNG output path inside the session working directory. Defaults to a unique file under generated-images/.",
    }),
  ),
  orchestratorModel: Type.Optional(
    Type.Union([Type.Literal("gpt-5.6-sol"), Type.Literal("gpt-5.6-luna")], {
      description: "Codex model that directs image generation. Defaults to gpt-5.6-sol.",
    }),
  ),
  thinking: Type.Optional(
    Type.Union([
      Type.Literal("minimal"),
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("xhigh"),
    ]),
  ),
});

function defaultPath(cwd: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(cwd, "generated-images", `codex-image-${timestamp}.png`);
}

function isInsideWorkspace(cwd: string, path: string): boolean {
  const rel = relative(resolve(cwd), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "generate_image",
    label: "Codex Image Generation",
    description:
      "Generate a raster image with Codex's native image_gen capability and existing Codex login. No OPENAI_API_KEY is required. Saves a PNG inside the current workspace.",
    parameters: ImageParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const requestedPath = params.outputPath?.trim();
      const outputPath = requestedPath
        ? resolve(ctx.cwd, requestedPath)
        : defaultPath(ctx.cwd);

      if (!isInsideWorkspace(ctx.cwd, outputPath)) {
        return {
          content: [{ type: "text", text: "Image output must stay inside the current workspace." }],
          details: { error: "output_outside_workspace", outputPath },
        };
      }
      if (!outputPath.toLowerCase().endsWith(".png")) {
        return {
          content: [{ type: "text", text: "Codex image output must use a .png path." }],
          details: { error: "invalid_output_extension", outputPath },
        };
      }
      if (existsSync(outputPath)) {
        return {
          content: [{ type: "text", text: `Refusing to overwrite existing image: ${outputPath}` }],
          details: { error: "output_exists", outputPath },
        };
      }

      const model = params.orchestratorModel ?? "gpt-5.6-sol";
      const thinking = params.thinking ?? "medium";
      onUpdate?.({
        content: [{ type: "text", text: `Generating image through Codex (${model}, ${thinking})...` }],
        details: { phase: "generating", model, thinking, outputPath },
      });

      const instruction = [
        "Use the native image_gen tool to generate a new raster image from this request:",
        params.prompt,
        `Save the finished PNG exactly at ${outputPath}.`,
        "Use image_gen, not code, SVG, HTML, canvas, or Python. Copy the selected built-in output into the workspace path, verify the file exists, and reply only with that path.",
      ].join("\n\n");

      const result = await pi.exec(
        "codex",
        [
          "exec",
          "--ephemeral",
          "--skip-git-repo-check",
          "--color",
          "never",
          "-C",
          ctx.cwd,
          "-s",
          "workspace-write",
          "-m",
          model,
          "-c",
          `model_reasoning_effort=\"${thinking}\"`,
          instruction,
        ],
        { signal, timeout: 600_000 },
      );

      if (result.code !== 0 || !existsSync(outputPath)) {
        const diagnostic = [result.stderr.trim(), result.stdout.trim()]
          .filter(Boolean)
          .join("\n")
          .slice(-4_000);
        const message = result.code !== 0
          ? `Codex image generation failed with exit ${result.code}.`
          : "Codex completed without creating the requested image.";
        return {
          content: [{ type: "text", text: diagnostic ? `${message}\n${diagnostic}` : message }],
          details: { error: "codex_image_generation_failed", exitCode: result.code, outputPath },
        };
      }

      const bytes = statSync(outputPath).size;
      return {
        content: [{ type: "text", text: `Generated image saved to ${outputPath}` }],
        details: { provider: "codex-image_gen", model, thinking, outputPath, bytes },
      };
    },
  });
}
