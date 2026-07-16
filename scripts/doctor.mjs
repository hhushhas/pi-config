#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
const index = args.indexOf("--target");
const target = resolve((index >= 0 ? args[index + 1] : undefined) ?? process.env.PI_CODING_AGENT_DIR ?? join(os.homedir(), ".pi", "agent"));
let failures = 0;
let warnings = 0;
const pass = (message) => console.log(`PASS  ${message}`);
const fail = (message) => { failures += 1; console.log(`FAIL  ${message}`); };
const warn = (message) => { warnings += 1; console.log(`WARN  ${message}`); };

function commandVersion(command, versionArgs = ["--version"]) {
  let executable = command;
  if (process.platform === "win32") {
    const located = spawnSync("where.exe", [command], { encoding: "utf8", timeout: 5_000 });
    const candidate = located.status === 0 ? located.stdout.trim().split(/\r?\n/)[0] : "";
    if (!candidate) return undefined;
    executable = candidate;
  }
  const result = spawnSync(executable, versionArgs, { encoding: "utf8", timeout: 10_000, shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(executable) });
  if (result.error || result.status !== 0) return undefined;
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split(/\r?\n/)[0];
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
nodeMajor >= 22 ? pass(`Node ${process.version}`) : fail(`Node 22+ required; found ${process.version}`);
const piVersion = commandVersion("pi");
piVersion === "0.80.6" ? pass("Pi 0.80.6") : fail(`Pi 0.80.6 required; found ${piVersion ?? "not on PATH"}`);
const pnpmVersion = commandVersion("pnpm");
pnpmVersion === "11.1.3" ? pass("pnpm 11.1.3") : warn(`pnpm 11.1.3 recommended for updates; found ${pnpmVersion ?? "not on PATH"}`);

const expected = [
  "AGENTS.md", "settings.json", "keybindings.json", join("auto-name", "settings.json"),
  join("packages", "portable-pi-setup", "package.json"),
  join("extensions", "subagent", "config.json"), "subagent-tool-description.md",
];
for (const relative of expected) {
  existsSync(join(target, relative)) ? pass(relative) : fail(`missing ${relative}`);
}

const settingsPath = join(target, "settings.json");
if (existsSync(settingsPath)) {
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const sources = (settings.packages ?? []).map((entry) => typeof entry === "string" ? entry : entry.source);
    sources.includes("./packages/portable-pi-setup") ? pass("portable package source is machine-relative") : fail("settings do not load ./packages/portable-pi-setup");
    sources.includes("npm:pi-chrome@0.15.46") ? pass("pi-chrome is pinned to 0.15.46") : fail("pi-chrome is not pinned to 0.15.46");
  } catch (error) {
    fail(`settings.json is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const optionalCommands = new Map([
  ["git", undefined],
  ["codex", "codex-cli 0.144.2"],
  ["claude", "2.1.210 (Claude Code)"],
  ["grok", "grok 0.2.101 (5bc4b5dfadcf)"],
  ["dcg", "0.6.8"],
  ["skillbox", "skillbox 0.2.0"],
]);
for (const [command, expectedVersion] of optionalCommands) {
  const version = commandVersion(command);
  if (!version) warn(`${command} is unavailable; its optional capability will fail open or remain unavailable`);
  else if (expectedVersion && version !== expectedVersion) warn(`${command} version drift: expected ${expectedVersion}, found ${version}`);
  else pass(`${command}: ${version}`);
}

const envPath = join(target, ".env");
const env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
/^FIRECRAWL_API_KEY=.+$/m.test(env) ? pass("FIRECRAWL_API_KEY configured") : warn("FIRECRAWL_API_KEY is not configured");
existsSync(join(target, "auth.json")) ? pass("Pi authentication file exists") : warn("Pi authentication is not configured yet");

function discoveredSkillFiles(root) {
  if (!existsSync(root)) return [];
  const result = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (entry.toLowerCase() === "skill.md") result.push(path);
    }
  };
  visit(root);
  return result;
}
function skillName(path) {
  return readFileSync(path, "utf8").match(/^---[\s\S]*?^name:\s*([^\r\n]+)$/m)?.[1]?.trim();
}
const packagedSkillRoot = join(target, "packages", "portable-pi-setup", "skills");
const packagedSkills = new Map(discoveredSkillFiles(packagedSkillRoot).map((path) => [skillName(path), path]));
const externalSkills = join(os.homedir(), ".agents", "skills");
const collisions = discoveredSkillFiles(externalSkills).flatMap((path) => {
  const packaged = packagedSkills.get(skillName(path));
  if (!packaged) return [];
  return readFileSync(path, "utf8") === readFileSync(packaged, "utf8") ? [] : [skillName(path)];
});
collisions.length > 0
  ? warn(`${externalSkills} shadows packaged skill(s) with different content: ${collisions.join(", ")}`)
  : pass("external skill discovery has no divergent packaged-skill collisions");

console.log(`\n${failures} failure(s), ${warnings} warning(s)`);
process.exitCode = failures === 0 ? 0 : 1;
