import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import askUser, {
  type AskUserDetails,
  type AskUserInput,
} from "./index.ts";
import { buildAskUserResultMessage } from "./prompt.ts";

const theme = {
  fg: (_name: string, text: string) => text,
  bold: (text: string) => text,
};

function registeredTool(): ToolDefinition {
  let tool: ToolDefinition | undefined;
  askUser({
    registerTool(definition: ToolDefinition) {
      tool = definition;
    },
  } as unknown as ExtensionAPI);
  assert.ok(tool);
  return tool;
}

async function runInteraction(
  drive: (component: Component) => void,
): Promise<{ content: Array<{ type: string; text: string }>; details: AskUserDetails }> {
  const tool = registeredTool();
  const params: AskUserInput = {
    question: "Which rollout?",
    options: [
      { label: "Canary", description: "Start with a small cohort" },
      { label: "Global" },
    ],
  };

  const result = await tool.execute(
    "call-1",
    params,
    undefined,
    undefined,
    {
      mode: "tui",
      ui: {
        custom: <T>(factory: (...args: any[]) => Component) =>
          new Promise<T>((resolve) => {
            const component = factory(
              {
                terminal: { rows: 40, columns: 100 },
                requestRender() {},
              },
              theme,
              undefined,
              (value: T) => resolve(value),
            );
            drive(component);
          }),
      },
    } as any,
  );

  return result as any;
}

function type(component: Component, text: string) {
  for (const character of text) component.handleInput?.(character);
}

test("keeps the public input schema unchanged", () => {
  const parameters = registeredTool().parameters as any;
  assert.deepEqual(Object.keys(parameters.properties), ["question", "options"]);
  assert.deepEqual(
    Object.keys(parameters.properties.options.items.properties),
    ["label", "description"],
  );
});

test("Enter immediately selects the highlighted supplied option", async () => {
  const result = await runInteraction((component) => component.handleInput?.("\r"));

  assert.equal(result.content[0]?.text, "User selected option 1: Canary");
  assert.deepEqual(result.details, {
    question: "Which rollout?",
    options: ["Canary", "Global"],
    answer: "Canary",
    wasCustom: false,
    cancelled: false,
  });
});

test("Tab adds a note to the highlighted option and exposes a concise hint", async () => {
  let picker = "";
  let noteEditor = "";
  const result = await runInteraction((component) => {
    picker = component.render(100).join("\n");
    component.handleInput?.("\t");
    noteEditor = component.render(100).join("\n");
    type(component, "Only for internal users");
    component.handleInput?.("\r");
  });

  assert.match(picker, /Tab\/n add note/);
  assert.match(noteEditor, /Note for Canary:/);
  assert.equal(
    result.content[0]?.text,
    "User selected option 1: Canary\nUser note: Only for internal users",
  );
  assert.deepEqual(result.details, {
    question: "Which rollout?",
    options: ["Canary", "Global"],
    answer: "Canary",
    wasCustom: false,
    cancelled: false,
    note: "Only for internal users",
  });
});

test("n is an alias for adding a note on a supplied option", async () => {
  const result = await runInteraction((component) => {
    component.handleInput?.("n");
    type(component, "Wait for metrics");
    component.handleInput?.("\r");
  });

  assert.equal(result.details.answer, "Canary");
  assert.equal(result.details.note, "Wait for metrics");
});

test("Escape leaves note entry and preserves the highlighted option", async () => {
  const result = await runInteraction((component) => {
    component.handleInput?.("\x1b[B");
    component.handleInput?.("\t");
    type(component, "discard this");
    component.handleInput?.("\x1b");
    component.handleInput?.("\r");
  });

  assert.equal(result.content[0]?.text, "User selected option 2: Global");
  assert.equal(result.details.answer, "Global");
  assert.equal(result.details.note, undefined);
});

test("Write my own answer still submits a custom answer", async () => {
  const result = await runInteraction((component) => {
    component.handleInput?.("3");
    type(component, "Pause the rollout");
    component.handleInput?.("\r");
  });

  assert.equal(
    result.content[0]?.text,
    "User wrote their own answer: Pause the rollout",
  );
  assert.equal(result.details.answer, "Pause the rollout");
  assert.equal(result.details.wasCustom, true);
  assert.equal(result.details.note, undefined);
});

test("selected result messaging includes an optional note as one answer", () => {
  assert.equal(
    buildAskUserResultMessage({
      kind: "selected",
      answer: "Canary",
      index: 1,
      note: "Only for internal users",
    }),
    "User selected option 1: Canary\nUser note: Only for internal users",
  );
});
