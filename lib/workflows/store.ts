import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowRun } from "./model.ts";

function projectKey(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 20);
}

function parseWorkflow(value: unknown): WorkflowRun | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<WorkflowRun>;
  if (candidate.schemaVersion !== 1 || typeof candidate.id !== "string" || typeof candidate.cwd !== "string") {
    return undefined;
  }
  if (!candidate.nodes || typeof candidate.nodes !== "object") return undefined;
  return candidate as WorkflowRun;
}

export class WorkflowStore {
  readonly projectDir: string;

  constructor(root: string, readonly cwd: string) {
    this.projectDir = join(root, projectKey(cwd));
  }

  workflowDir(workflowId: string): string {
    return join(this.projectDir, workflowId);
  }

  attemptDir(workflowId: string, nodeId: string, attemptNumber: number): string {
    return join(this.workflowDir(workflowId), "nodes", nodeId, `attempt-${attemptNumber}`);
  }

  async initialize(): Promise<void> {
    await mkdir(this.projectDir, { recursive: true });
  }

  async loadAll(): Promise<WorkflowRun[]> {
    await this.initialize();
    const entries = await readdir(this.projectDir, { withFileTypes: true });
    const workflows: WorkflowRun[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = await readFile(join(this.projectDir, entry.name, "state.json"), "utf8");
        const workflow = parseWorkflow(JSON.parse(raw));
        if (workflow?.cwd === this.cwd) workflows.push(workflow);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return workflows.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async load(workflowId: string): Promise<WorkflowRun | undefined> {
    try {
      const raw = await readFile(join(this.workflowDir(workflowId), "state.json"), "utf8");
      const workflow = parseWorkflow(JSON.parse(raw));
      return workflow?.cwd === this.cwd ? workflow : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  save(workflow: WorkflowRun): Promise<void> {
    this.saveSync(workflow);
    return Promise.resolve();
  }

  saveSync(workflow: WorkflowRun): void {
    workflow.updatedAt = Date.now();
    const directory = this.workflowDir(workflow.id);
    mkdirSync(directory, { recursive: true });
    const target = join(directory, "state.json");
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(workflow, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, target);
  }

  async prepareAttempt(workflowId: string, nodeId: string, attemptNumber: number): Promise<string> {
    const directory = this.attemptDir(workflowId, nodeId, attemptNumber);
    await mkdir(join(directory, "sessions"), { recursive: true });
    return directory;
  }
}
