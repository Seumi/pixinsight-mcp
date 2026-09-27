import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config.ts";
import type { Connection, McpResult } from "../src/client.ts";
import { PixInsightService, validateSettings, type Interaction } from "../src/service.ts";
import { WORKSPACE_SCRIPT } from "../src/scripts.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9e0AAAAASUVORK5CYII=", "base64");
const yes: Interaction = { hasUI: true, confirm: async () => true };
const no: Interaction = { hasUI: true, confirm: async () => false };
const headless: Interaction = { hasUI: false, confirm: async () => { throw new Error("must not confirm"); } };
const text = (value: string): McpResult => ({ content: [{ type: "text", text: value }] });

class FakeConnection implements Connection {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  current = { instance: 1, activeViewId: "Light", images: [{
    id: "Light", width: 4000, height: 3000, channels: 3, bitsPerSample: 32, isReal: true,
    isColor: true, filePath: null, historyIndex: 0, linearState: "unknown", stf: [],
  }] };
  failure = false;
  hang = false;
  mismatchPath = false;
  active = 0;
  peak = 0;
  closed = false;
  async tools() { return ["run_script", "get_image_statistics", "get_process_parameters", "render_view", "run_process"]; }
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpResult> {
    this.calls.push({ name, args });
    this.peak = Math.max(this.peak, ++this.active);
    try {
      signal?.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 1));
      if (name === "run_script") {
        assert.equal(args.code, WORKSPACE_SCRIPT);
        return text(JSON.stringify(this.current));
      }
      if (name === "run_process") {
        if (this.failure) throw new Error("server error after dispatch");
        if (this.hang) await new Promise((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        this.current.images[0].historyIndex++;
        return text("process succeeded");
      }
      if (name === "render_view") {
        const path = String(args.outputPath);
        await writeFile(path, png);
        return text(JSON.stringify({ path: this.mismatchPath ? path + ".unexpected" : path, viewId: args.viewId, width: 1, height: 1 }));
      }
      return text("mean=0.1 median=0.05");
    } finally { this.active--; }
  }
  async close() { this.closed = true; }
}

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pi-pixinsight-test-"));
  const config: Config = { serverPath: "unused", bridgeDir: join(dir, "bridge"), stateDir: join(dir, "state"), instance: 1, timeoutMs: 1000, watchIntervalMs: 2000 };
  await mkdir(join(config.bridgeDir, "commands"), { recursive: true });
  await writeFile(join(config.bridgeDir, "heartbeat.json"), "{}");
  const fake = new FakeConnection();
  const service = new PixInsightService(config, fake);
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  return { config, fake, service };
}

test("配置固定实例、扩展 ~、拒绝非绝对路径和非法数字", () => {
  const home = tmpdir();
  const config = loadConfig({ PIXINSIGHT_MCP_INSTANCE: "2", PIXINSIGHT_MCP_BRIDGE_DIR: "~/bridge" }, home);
  assert.equal(config.instance, 2);
  assert.equal(config.bridgeDir, join(home, "bridge"));
  assert.match(config.serverPath, /build[/\\]index\.js$/);
  assert.throws(() => loadConfig({ PIXINSIGHT_MCP_INSTANCE: "2abc" }), /整数/);
  assert.throws(() => loadConfig({ PIXINSIGHT_MCP_SERVER: "relative.js" }), /绝对/);
  assert.throws(() => loadConfig({ PIXINSIGHT_AGENT_WATCH_MS: "1" }), /整数/);
});

test("无 heartbeat 不投递任何 PI 命令", async t => {
  const h = await setup(t);
  await rm(join(h.config.bridgeDir, "heartbeat.json"));
  await assert.rejects(h.service.workspace(), /未投递命令/);
  assert.equal(h.fake.calls.length, 0);
  const status = await h.service.status();
  assert.equal((status.details.heartbeat as { live: boolean }).live, false);
});

test("工作区带采样时间，固定只读脚本；拒绝错实例", async t => {
  const h = await setup(t);
  const ws = await h.service.workspace();
  assert.equal(ws.activeViewId, "Light");
  assert.equal(ws.images[0].linearState, "unknown");
  assert.ok(Date.parse(ws.capturedAt));
  h.fake.current.instance = 2;
  await assert.rejects(h.service.workspace(), /实例编号/);
});

test("并行工具请求在服务内串行化", async t => {
  const h = await setup(t);
  await Promise.all([h.service.workspace(), h.service.inspect("Light"), h.service.parameters("SCNR")]);
  assert.equal(h.fake.peak, 1);
  assert.equal(h.service.busy, false);
});

test("默认禁止处理；headless 即使解锁也拒绝", async t => {
  const h = await setup(t);
  await assert.rejects(h.service.runProcess("SCNR", "Light", {}, yes), /默认关闭/);
  h.service.writesEnabled = true;
  await assert.rejects(h.service.runProcess("SCNR", "Light", {}, headless), /默认关闭/);
  assert.equal(h.fake.calls.length, 0);
});

test("取消确认后不处理、不写恢复锁", async t => {
  const h = await setup(t);
  h.service.writesEnabled = true;
  await assert.rejects(h.service.runProcess("SCNR", "Light", {}, no), /用户取消/);
  assert.ok(!h.fake.calls.some(c => c.name === "run_process"));
  assert.equal(await h.service.pending(), undefined);
});

test("确认期间源图发生变化，拒绝执行", async t => {
  const h = await setup(t);
  h.service.writesEnabled = true;
  const changing: Interaction = { hasUI: true, confirm: async () => { h.fake.current.images[0].historyIndex++; return true; } };
  await assert.rejects(h.service.runProcess("SCNR", "Light", {}, changing), /状态发生变化/);
  assert.ok(!h.fake.calls.some(c => c.name === "run_process"));
});

test("确认期间禁用写权限，拒绝执行", async t => {
  const h = await setup(t);
  h.service.writesEnabled = true;
  const revoke: Interaction = { hasUI: true, confirm: async () => { h.service.writesEnabled = false; return true; } };
  await assert.rejects(h.service.runProcess("SCNR", "Light", {}, revoke), /权限/);
  assert.ok(!h.fake.calls.some(c => c.name === "run_process"));
});

test("确认后固定目标处理一次、记录日志并复测", async t => {
  const h = await setup(t);
  h.service.writesEnabled = true;
  const result = await h.service.runProcess("SCNR", "Light", { amount: 0.5 }, yes);
  assert.equal(result.details.executionSucceeded, true);
  assert.equal(h.fake.calls.filter(c => c.name === "run_process").length, 1);
  assert.equal(h.fake.calls.find(c => c.name === "run_process")?.args.viewId, "Light");
  assert.equal(await h.service.pending(), undefined);
  const audit = (await readFile(join(h.config.stateDir, "operations.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual(audit.map(a => a.stage), ["dispatching", "succeeded"]);
});

test("处理失败保留跨会话锁；自动重试被阻止", async t => {
  const h = await setup(t);
  h.service.writesEnabled = true;
  h.fake.failure = true;
  await assert.rejects(h.service.runProcess("SCNR", "Light", {}, yes), /结果不确定/);
  const next = new PixInsightService(h.config, h.fake);
  t.after(() => next.close());
  next.writesEnabled = true;
  await assert.rejects(next.runProcess("SCNR", "Light", {}, yes), /禁止自动重试/);
  assert.equal(h.fake.calls.filter(c => c.name === "run_process").length, 1);
});

test("执行后取消不声称回滚；保留恢复锁", async t => {
  const h = await setup(t);
  h.service.writesEnabled = true;
  h.fake.hang = true;
  const controller = new AbortController();
  const run = h.service.runProcess("SCNR", "Light", {}, yes, controller.signal);
  const killer = setInterval(() => { if (h.fake.calls.some(c => c.name === "run_process")) controller.abort(); }, 1);
  try { await assert.rejects(run, /结果不确定/); } finally { clearInterval(killer); }
  assert.ok(await h.service.pending());
});

test("队列有残留命令时不能恢复；清空后须确认且重新锁定写权限", async t => {
  const h = await setup(t);
  h.service.writesEnabled = true;
  h.fake.failure = true;
  await assert.rejects(h.service.runProcess("SCNR", "Light", {}, yes));
  const command = join(h.config.bridgeDir, "commands", "pending.json");
  await writeFile(command, "{}");
  await assert.rejects(h.service.recover(yes), /待处理命令/);
  await rm(command);
  await assert.rejects(h.service.recover(no), /取消恢复/);
  await h.service.recover(yes);
  assert.equal(await h.service.pending(), undefined);
  assert.equal(h.service.writesEnabled, false);
});

test("不存在/表达式目标、任意 JS 进程和原型污染参数被拒绝", async t => {
  const h = await setup(t);
  assert.throws(() => h.service.runProcess("JavaScriptRuntime", "Light", {}, yes), /未开放/);
  assert.throws(() => h.service.runProcess("SCNR", "Light;evil()", {}, yes), /主视图/);
  assert.throws(() => validateSettings(JSON.parse('{"__proto__":{"x":1}}')), /禁止/);
  assert.throws(() => validateSettings({ amount: NaN }), /有限/);
  await assert.rejects(h.service.inspect("Missing"), /不存在/);
});

test("preview 无确认不渲染、不上传；有确认返回 pi image 内容", async t => {
  const h = await setup(t);
  await assert.rejects(h.service.preview("Light", "view", undefined, headless), /交互确认/);
  await assert.rejects(h.service.preview("Light", "view", undefined, no), /取消/);
  assert.ok(!h.fake.calls.some(c => c.name === "render_view"));
  const result = await h.service.preview("Light", "view", undefined, yes);
  const image = result.content.find(c => c.type === "image");
  assert.equal(image?.type, "image");
  if (image?.type === "image") assert.equal(image.mimeType, "image/png");
  assert.equal(h.fake.calls.find(c => c.name === "render_view")?.args.downsample, 3);
});

test("preview 拒绝越界裁剪和意外文件路径", async t => {
  const h = await setup(t);
  await assert.rejects(h.service.preview("Light", "asis", [0, 0, 99999, 1], yes), /裁剪/);
  h.fake.mismatchPath = true;
  await assert.rejects(h.service.preview("Light", "asis", undefined, yes), /非请求/);
});

test("大文本落盘，模型结果有明确截断和路径", async t => {
  const h = await setup(t);
  const result = await h.service.result("x".repeat(30_000));
  assert.equal((await readFile(String(result.details.fullOutputPath))).length, 30_000);
  assert.equal((await readdir(join(h.config.stateDir, "artifacts"))).length, 1);
});
