#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const target = resolve(valueAfter("--target") ?? process.env.PI_CODING_AGENT_DIR ?? join(os.homedir(), ".pi", "agent"));
const skipDeps = args.includes("--skip-deps");
const dryRun = args.includes("--dry-run");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupRoot = join(target, "backups", `portable-pi-setup-${stamp}`);
const packageTarget = join(target, "packages", "portable-pi-setup");
const staging = join(target, "packages", `.portable-pi-setup-${process.pid}.staging`);

const packageEntries = [
  "AGENTS.md", "auto-name", "extensions", "keybindings.json", "lib", "package.json",
  "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "prompts", "scripts", "settings.json", "skills",
  "subagent-config.json", "subagent-tool-description.md", "support",
];
const rootEntries = ["AGENTS.md", "keybindings.json", "settings.json", join("auto-name", "settings.json")];
const legacyEntries = [
  join("extensions", "dcg-guard.ts"),
  join("extensions", "manual-only-skills.ts"),
  join("extensions", "openai-image-generation.ts"),
  "prompts",
  "skills",
];

function log(message) { console.log(message); }
function ensureParent(path) { mkdirSync(dirname(path), { recursive: true }); }
function backup(relative) {
  const source = join(target, relative);
  if (!existsSync(source)) return;
  const destination = join(backupRoot, relative);
  ensureParent(destination);
  renameSync(source, destination);
  log(`backed up ${relative}`);
}
function copy(source, destination) {
  ensureParent(destination);
  cpSync(source, destination, { recursive: true, force: true, dereference: true });
}

if (Number(process.versions.node.split(".")[0]) < 22) {
  throw new Error(`Node 22 or newer is required; found ${process.version}.`);
}
if (dryRun) {
  log(`would install portable-pi-setup from ${root} into ${target}`);
  log(`would preserve credentials, sessions, trust decisions, workflow state, and existing .env`);
  process.exit(0);
}

mkdirSync(join(target, "packages"), { recursive: true });
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
try {
  for (const entry of packageEntries) copy(join(root, entry), join(staging, entry));

  if (!skipDeps) {
    const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const result = spawnSync(pnpm, ["install", "--prod", "--frozen-lockfile"], {
      cwd: staging,
      stdio: "inherit",
      env: { ...process.env, CI: "1" },
    });
    if (result.error) throw new Error(`Could not run pnpm: ${result.error.message}. Install pnpm 11.1.3 and retry.`);
    if (result.status !== 0) throw new Error(`pnpm install failed with exit ${result.status ?? "unknown"}.`);
  }

  for (const entry of rootEntries) backup(entry);
  for (const entry of legacyEntries) backup(entry);
  backup(join("extensions", "subagent", "config.json"));
  backup("subagent-tool-description.md");
  if (existsSync(packageTarget)) backup(join("packages", "portable-pi-setup"));

  renameSync(staging, packageTarget);
  for (const entry of rootEntries) copy(join(root, entry), join(target, entry));
  copy(join(root, "subagent-config.json"), join(target, "extensions", "subagent", "config.json"));
  copy(join(root, "subagent-tool-description.md"), join(target, "subagent-tool-description.md"));

  const readingRoom = join(target, "reading-room");
  const existingRegistry = existsSync(join(readingRoom, "registry.js"))
    ? readFileSync(join(readingRoom, "registry.js"), "utf8")
    : undefined;
  copy(join(root, "support", "reading-room"), readingRoom);
  if (existingRegistry !== undefined) writeFileSync(join(readingRoom, "registry.js"), existingRegistry);

  const envFile = join(target, ".env");
  if (!existsSync(envFile)) writeFileSync(envFile, "# FIRECRAWL_API_KEY=\n", { mode: 0o600 });
  try { chmodSync(envFile, 0o600); } catch { /* Windows ACLs are managed separately. */ }

  log(`installed portable-pi-setup in ${target}`);
  if (existsSync(backupRoot)) log(`backup: ${backupRoot}`);
  log(`next: PI_CODING_AGENT_DIR=${JSON.stringify(target)} node ${JSON.stringify(join(packageTarget, "scripts", "doctor.mjs"))}`);
} catch (error) {
  rmSync(staging, { recursive: true, force: true });
  throw error;
}
