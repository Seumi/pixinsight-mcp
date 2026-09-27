import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { PixInsightService } from "../src/service.ts";

const live = process.argv.includes("--live");
const directory = live ? undefined : await mkdtemp(join(tmpdir(), "pi-pixinsight-smoke-"));
const config = loadConfig();
if (directory) {
  config.bridgeDir = join(directory, "bridge");
  config.stateDir = join(directory, "state");
}
const service = new PixInsightService(config);
try {
  const status = await service.status();
  const required = status.details.requiredTools as Record<string, boolean>;
  if (Object.values(required).some(value => !value)) throw new Error("MCP server 缺少所需工具");
  console.log("PASS: 真实 MCP stdio 握手与所需工具发现");
  if (live) {
    const workspace = await service.workspace();
    console.log(`PASS: 真实 PixInsight 实例 ${workspace.instance}，${workspace.images.length} 个主视图；仅查询，未处理/上传图像`);
  } else {
    console.log("未测试真实 PixInsight。桥接目录已隔离，没有发送 PI 命令。");
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
} finally {
  await service.close();
  if (directory) await rm(directory, { recursive: true, force: true });
}
