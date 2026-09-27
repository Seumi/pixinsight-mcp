import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/extension.ts";

test("factory 只注册六个受控工具，不暴露任意脚本/关闭/保存", () => {
  const tools: Array<{ name: string; executionMode?: string }> = [];
  const commands: string[] = [];
  const events: string[] = [];
  const api = {
    registerTool: (tool: typeof tools[number]) => tools.push(tool),
    registerCommand: (name: string) => commands.push(name),
    on: (name: string) => events.push(name),
  } as unknown as ExtensionAPI;
  extension(api);
  assert.deepEqual(tools.map(t => t.name).sort(), ["pixinsight_inspect", "pixinsight_parameters", "pixinsight_preview", "pixinsight_process", "pixinsight_status", "pixinsight_workspace"]);
  assert.ok(tools.every(t => t.executionMode === "sequential"));
  assert.deepEqual(commands, ["pixinsight"]);
  assert.ok(events.includes("session_shutdown"));
});

test("实际 pi extension loader 能加载包并注册工具", { timeout: 30000 }, async () => {
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const loaderUrl = new URL("./core/extensions/loader.js", entry);
  const { loadExtensions } = await import(loaderUrl.href);
  const path = fileURLToPath(new URL("../src/extension.ts", import.meta.url));
  const result = await loadExtensions([path], fileURLToPath(new URL("../", import.meta.url)));
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  assert.equal(result.extensions[0].tools.size, 6);
  assert.ok(result.extensions[0].commands.has("pixinsight"));
});
