import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { McpConnection, resultText } from "../src/client.ts";

test("标准 MCP stdio 握手、调用、错误、取消及清理", { timeout: 15000 }, async t => {
  const config = loadConfig();
  config.serverPath = fileURLToPath(new URL("../fixtures/mcp-server.mjs", import.meta.url));
  const client = new McpConnection(config);
  t.after(() => client.close());
  assert.deepEqual((await client.tools()).sort(), ["echo", "fail", "wait"]);
  assert.equal(resultText(await client.call("echo", { message: "hello" })), "hello");
  await assert.rejects(client.call("fail", {}), /fixture failure/);
  await assert.rejects(client.call("missing", {}), /不支持/);
  await assert.rejects(client.call("wait", {}, AbortSignal.timeout(30)));
  await client.close();
  await client.close();
  await assert.rejects(client.tools(), /已关闭/);
});
