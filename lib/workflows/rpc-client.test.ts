import assert from "node:assert/strict";
import test from "node:test";
import { SubagentRpcClient, SubagentRpcError } from "./rpc-client.ts";

class FakeEvents {
  handlers = new Map<string, Array<(value: unknown) => void>>();
  reply?: (request: Record<string, unknown>) => Record<string, unknown>;

  on(event: string, handler: (value: unknown) => void): () => void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return () => this.handlers.set(event, (this.handlers.get(event) ?? []).filter((candidate) => candidate !== handler));
  }

  emit(event: string, value: unknown): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(value);
    if (event !== "subagents:rpc:v2:request" || !this.reply) return;
    const request = value as Record<string, unknown>;
    const reply = this.reply(request);
    this.emit(`subagents:rpc:v2:reply:${String(request.requestId)}`, { version: 2, requestId: request.requestId, success: true, data: reply });
  }
}

const methods = ["ping", "status", "lookup", "spawn", "interrupt", "stop", "steer", "resume"];
const capabilities = { idempotentSpawn: true, idempotentResume: true, causalControls: true, eventOnlyNotifications: true, steerAcknowledgement: true };

test("RPC client accepts only the complete workflow protocol v2 contract", async () => {
  const events = new FakeEvents();
  events.reply = () => ({ version: 2, methods, capabilities, session: { cwd: "/repo", sessionId: "session" } });
  const client = new SubagentRpcClient(events as never);
  assert.equal((await client.waitForSession()).session.sessionId, "session");
  client.dispose();

  const incomplete = new FakeEvents();
  incomplete.reply = () => ({ version: 2, methods, capabilities: { ...capabilities, idempotentResume: false }, session: { sessionId: "session" } });
  const rejected = new SubagentRpcClient(incomplete as never);
  await assert.rejects(rejected.waitForSession(), /workflow protocol is incompatible/);
  rejected.dispose();
});

test("RPC client surfaces structured runtime errors", async () => {
  const events = new FakeEvents();
  events.emit = function emit(event: string, value: unknown): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(value);
    if (event !== "subagents:rpc:v2:request") return;
    const request = value as Record<string, unknown>;
    this.emit(`subagents:rpc:v2:reply:${String(request.requestId)}`, { version: 2, requestId: request.requestId, success: false, error: { code: "unauthorized", message: "wrong lease" } });
  };
  const client = new SubagentRpcClient(events as never);
  await assert.rejects(client.status("run"), (error: unknown) => error instanceof SubagentRpcError && error.code === "unauthorized" && error.message === "wrong lease");
  client.dispose();
});
