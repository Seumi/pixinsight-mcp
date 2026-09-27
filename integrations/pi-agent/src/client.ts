import { access } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Config } from "./config.ts";

export interface McpResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}
export interface Connection {
  tools(): Promise<string[]>;
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpResult>;
  close(): Promise<void>;
}

export function resultText(result: McpResult): string {
  return result.content.filter(c => c.type === "text").map(c => c.text ?? "").join("\n");
}

export class McpConnection implements Connection {
  private client?: Client;
  private transport?: StdioClientTransport;
  private connecting?: Promise<void>;
  private names: string[] = [];
  private closed = false;
  private stderr = "";
  readonly config: Config;

  constructor(config: Config) { this.config = config; }

  private async connect(): Promise<void> {
    if (this.closed) throw new Error("连接已关闭，请重新加载扩展");
    if (this.connecting) return this.connecting;
    if (this.client) return;
    this.connecting = (async () => {
      await access(this.config.serverPath).catch(() => { throw new Error(`找不到 MCP server: ${this.config.serverPath}。请先在仓库根目录运行 npm ci && npm run build`); });
      if (this.closed) throw new Error("连接已关闭");
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [this.config.serverPath],
        // 不把模型 API key 等父进程机密传给桥接服务；固定实例，禁止自动选错实例。
        env: {
          ...getDefaultEnvironment(),
          PIXINSIGHT_MCP_INSTANCE: String(this.config.instance),
          PIXINSIGHT_MCP_BRIDGE_DIR: this.config.bridgeDir,
          PIXINSIGHT_MCP_TIMEOUT_MS: String(this.config.timeoutMs),
        },
        stderr: "pipe",
      });
      transport.stderr?.on("data", chunk => { this.stderr = (this.stderr + String(chunk)).slice(-4000); });
      const client = new Client({ name: "pi-pixinsight", version: "0.1.0" });
      this.transport = transport;
      this.client = client;
      try {
        await client.connect(transport, { timeout: 10_000 });
        const listed = await client.listTools(undefined, { timeout: 10_000 });
        this.names = listed.tools.map(t => t.name);
      } catch (error) {
        await transport.close().catch(() => {});
        this.client = undefined;
        this.transport = undefined;
        throw new Error(`MCP 连接失败: ${String(error)}${this.stderr ? `\n${this.stderr}` : ""}`);
      }
    })();
    try { await this.connecting; } finally { this.connecting = undefined; }
  }

  async tools(): Promise<string[]> { await this.connect(); return [...this.names]; }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpResult> {
    signal?.throwIfAborted();
    await this.connect();
    signal?.throwIfAborted();
    if (!this.names.includes(name)) throw new Error(`MCP server 不支持 ${name}，请检查版本`);
    const result = await this.client!.callTool({ name, arguments: args }, undefined, {
      signal,
      // 超过 bridge 自己的超时，避免 SDK 默认 60 秒提前断开；不伪造进度。
      timeout: this.config.timeoutMs + 10_000,
    }) as McpResult;
    if (result.isError) throw new Error(resultText(result) || `${name} 失败`);
    return result;
  }

  async close(): Promise<void> {
    this.closed = true;
    // 关闭 stdio 只关闭 MCP 子进程，不会终止 PixInsight 中已开始的处理。
    await this.client?.close().catch(() => {});
    await this.connecting?.catch(() => {});
    await this.transport?.close().catch(() => {});
    this.client = undefined;
    this.transport = undefined;
  }
}
