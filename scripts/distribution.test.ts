import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

function tempTarget() {
  return mkdtempSync(join(tmpdir(), "portable-pi-setup-"));
}

test("installer creates a self-contained setup and preserves private state", () => {
  const target = tempTarget();
  try {
    mkdirSync(join(target, "prompts"), { recursive: true });
    mkdirSync(join(target, "skills"), { recursive: true });
    mkdirSync(join(target, "reading-room"), { recursive: true });
    writeFileSync(join(target, "settings.json"), '{"old":true}\n');
    writeFileSync(join(target, ".env"), "FIRECRAWL_API_KEY=secret\n");
    writeFileSync(join(target, "prompts", "old.md"), "old");
    writeFileSync(join(target, "skills", "old.md"), "old");
    writeFileSync(join(target, "reading-room", "registry.js"), "const READING_ROOM = [];\n// keep\n");

    execFileSync(process.execPath, [join(root, "scripts", "install.mjs"), "--target", target, "--skip-deps"], { cwd: root });

    const settings = JSON.parse(readFileSync(join(target, "settings.json"), "utf8"));
    const sources = settings.packages.map((entry: string | { source: string }) => typeof entry === "string" ? entry : entry.source);
    assert.ok(sources.includes("./packages/portable-pi-setup"));
    assert.ok(sources.includes("npm:pi-chrome@0.15.46"));
    assert.equal(readFileSync(join(target, ".env"), "utf8"), "FIRECRAWL_API_KEY=secret\n");
    assert.match(readFileSync(join(target, "reading-room", "registry.js"), "utf8"), /keep/);
    assert.equal(JSON.parse(readFileSync(join(target, "packages", "portable-pi-setup", "package.json"), "utf8")).version, "1.0.0");
    assert.match(readFileSync(join(target, "backups", findBackup(target), "settings.json"), "utf8"), /old/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

function findBackup(target: string): string {
  return readdirSync(join(target, "backups"))[0]!;
}

test("package manifest and settings expose the same managed resources", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
  const local = settings.packages.find((entry: { source?: string }) => entry.source === "./packages/portable-pi-setup");
  assert.ok(local);
  for (const kind of ["extensions", "skills", "prompts"] as const) {
    assert.deepEqual(local[kind].map((path: string) => path.replace(/^\+/, "")).sort(), [...pkg.pi[kind]].sort());
  }
});

test("distributed resources contain no owner name or absolute macOS home path", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const textExtensions = new Set([".md", ".ts", ".js", ".mjs", ".json", ".yaml", ".yml", ".html"]);
  const visit = (path: string) => {
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path)) {
        if (name === "node_modules" || name.endsWith(".test.ts")) continue;
        visit(join(path, name));
      }
      return;
    }
    const extension = path.slice(path.lastIndexOf("."));
    if (!textExtensions.has(extension)) return;
    const text = readFileSync(path, "utf8");
    assert.doesNotMatch(text, /Hasan|\/Users\/macmini/);
  };
  for (const entry of pkg.files) visit(join(root, entry.replace(/\/$/, "")));
});
