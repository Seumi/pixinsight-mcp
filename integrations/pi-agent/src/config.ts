import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  serverPath: string;
  bridgeDir: string;
  stateDir: string;
  instance: number;
  timeoutMs: number;
  watchIntervalMs: number;
}

function integer(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} 必须是 ${min}..${max} 的整数`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, home = homedir()): Config {
  const absolute = (value: string) => {
    const path = value.startsWith("~/") || value.startsWith("~\\") ? join(home, value.slice(2)) : value;
    if (!isAbsolute(path)) throw new Error(`配置路径必须为绝对路径: ${value}`);
    return resolve(path);
  };
  const instance = integer(env.PIXINSIGHT_MCP_INSTANCE, 1, 1, 9999, "PIXINSIGHT_MCP_INSTANCE");
  return {
    serverPath: absolute(env.PIXINSIGHT_MCP_SERVER ?? fileURLToPath(new URL("../../../build/index.js", import.meta.url))),
    bridgeDir: absolute(env.PIXINSIGHT_MCP_BRIDGE_DIR ?? join(home, ".pixinsight-mcp", instance === 1 ? "bridge" : `bridge-${instance}`)),
    stateDir: absolute(env.PIXINSIGHT_AGENT_STATE_DIR ?? join(home, ".pi", "agent", "pixinsight")),
    instance,
    timeoutMs: integer(env.PIXINSIGHT_MCP_TIMEOUT_MS, 300_000, 1000, 3_600_000, "PIXINSIGHT_MCP_TIMEOUT_MS"),
    watchIntervalMs: integer(env.PIXINSIGHT_AGENT_WATCH_MS, 5000, 2000, 60_000, "PIXINSIGHT_AGENT_WATCH_MS"),
  };
}

export async function heartbeat(config: Config) {
  try {
    const info = await stat(join(config.bridgeDir, "heartbeat.json"));
    const ageMs = Date.now() - info.mtimeMs;
    return { live: ageMs >= -1000 && ageMs < 6000, ageMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { live: false, ageMs: null };
  }
}

export async function requireLive(config: Config): Promise<void> {
  if (!(await heartbeat(config)).live) {
    throw new Error(`PixInsight 实例 ${config.instance} 没有新鲜 heartbeat（也可能正在忙）。请安装模块并启动 Process > Utilities > MCP Watcher > Start；本次未投递命令。桥接目录: ${config.bridgeDir}`);
  }
}
