// 根包测试包括 MCP 和原生模块；独立 pi 包的测试由它自己的 npm test 运行。
// 用 Node 枚举文件而不是 shell glob，Windows、macOS 和 Linux 行为一致。
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

async function discover(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !["node_modules", "build", ".git"].includes(entry.name))
      files.push(...await discover(path));
    else if (entry.isFile() && entry.name.endsWith(".test.mjs"))
      files.push(path);
  }
  return files;
}
const files = (await Promise.all(["../test/", "../module/"].map(directory =>
  discover(fileURLToPath(new URL(directory, import.meta.url)))
))).flat().sort();
if (files.length === 0) throw new Error("没有找到根包测试");
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
