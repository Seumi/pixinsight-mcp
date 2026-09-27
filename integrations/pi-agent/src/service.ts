import { createHash, randomUUID } from "node:crypto";
import { appendFile, chmod, lstat, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { heartbeat, requireLive, type Config } from "./config.ts";
import { McpConnection, resultText, type Connection, type McpResult } from "./client.ts";
import { identifier, WORKSPACE_SCRIPT, type ImageInfo, type Workspace } from "./scripts.ts";

export const ALLOWED_PROCESSES = [
  "ScreenTransferFunction", "HistogramTransformation", "CurvesTransformation", "SCNR",
  "AutomaticBackgroundExtractor", "BackgroundNeutralization", "ColorCalibration",
  "SpectrophotometricColorCalibration", "BlurXTerminator", "NoiseXTerminator", "StarXTerminator",
] as const;

export interface Interaction {
  hasUI: boolean;
  confirm(title: string, message: string, signal?: AbortSignal): Promise<boolean>;
}
export interface ToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  details: Record<string, unknown>;
}
export interface PendingOperation {
  id: string;
  instance: number;
  bridgeDir: string;
  processId: string;
  viewId: string;
  settings: Record<string, unknown>;
  startedAt: string;
}

export function validateSettings(settings: Record<string, unknown>): void {
  const visit = (value: unknown, depth: number): void => {
    if (depth > 12) throw new Error("参数嵌套过深");
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (Array.isArray(value)) { value.forEach(v => visit(v, depth + 1)); return; }
    if (typeof value === "object" && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error(`禁止的参数名: ${key}`);
        visit(child, depth + 1);
      }
      return;
    }
    throw new Error("参数只能包含有限数值、字符串、布尔值、null、数组和对象");
  };
  visit(settings, 0);
  if (JSON.stringify(settings).length > 8000) throw new Error("参数超过 8000 字符，请缩小操作以便完整确认");
}

export class PixInsightService {
  readonly config: Config;
  readonly connection: Connection;
  readonly lockPath: string;
  writesEnabled = false;
  workspaceCache?: Workspace;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private lifecycle = new AbortController();

  constructor(config: Config, connection: Connection = new McpConnection(config)) {
    this.config = config;
    this.connection = connection;
    const key = createHash("sha256").update(config.bridgeDir).digest("hex").slice(0, 20);
    this.lockPath = join(config.stateDir, `${key}.pending.json`);
  }

  get busy(): boolean { return this.queued > 0; }

  private serial<T>(fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const combined = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
    this.queued++;
    const task = this.tail.then(() => { combined.throwIfAborted(); return fn(combined); });
    this.tail = task.catch(() => {});
    return task.finally(() => { this.queued--; });
  }

  async pending(): Promise<PendingOperation | undefined> {
    try { return JSON.parse(await readFile(this.lockPath, "utf8")) as PendingOperation; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async result(text: string, details: Record<string, unknown> = {}): Promise<ToolResult> {
    if (text.length > 24_000) {
      await mkdir(join(this.config.stateDir, "artifacts"), { recursive: true, mode: 0o700 });
      const path = join(this.config.stateDir, "artifacts", `${randomUUID()}.txt`);
      await writeFile(path, text, { mode: 0o600, flag: "wx" });
      text = text.slice(0, 24_000) + `\n[已截断；完整输出: ${path}]`;
      details = { ...details, fullOutputPath: path };
    }
    return { content: [{ type: "text", text }], details };
  }

  status(signal?: AbortSignal): Promise<ToolResult> {
    return this.serial(async () => {
      const tools = await this.connection.tools();
      const state = {
        instance: this.config.instance, bridgeDir: this.config.bridgeDir,
        mcpConnected: true, heartbeat: await heartbeat(this.config),
        writesEnabled: this.writesEnabled, pendingOperation: await this.pending() ?? null,
        requiredTools: Object.fromEntries(["run_script", "get_image_statistics", "get_process_parameters", "render_view", "run_process"].map(n => [n, tools.includes(n)])),
        note: "MCP 连接成功不代表 PixInsight Watcher 已启动；heartbeat 过期也可能是 PI 正在忙。",
      };
      return this.result(JSON.stringify(state, null, 2), state);
    }, signal);
  }

  private async readWorkspace(signal: AbortSignal): Promise<Workspace> {
    await requireLive(this.config);
    const value = JSON.parse(resultText(await this.connection.call("run_script", { code: WORKSPACE_SCRIPT }, signal)));
    if (!Array.isArray(value.images) || value.instance !== this.config.instance) throw new Error("工作区协议或实例编号不匹配，拒绝使用结果");
    for (const im of value.images) {
      if (typeof im.id !== "string" || !Number.isInteger(im.width) || im.width < 1 || !Number.isInteger(im.height) || im.height < 1) throw new Error("无效的图像描述");
    }
    const state: Workspace = { ...value, capturedAt: new Date().toISOString() };
    this.workspaceCache = state;
    return state;
  }

  workspace(signal?: AbortSignal): Promise<Workspace> {
    return this.serial(s => this.readWorkspace(s), signal);
  }

  private target(workspace: Workspace, viewId: string): ImageInfo {
    identifier(viewId);
    const view = workspace.images.find(v => v.id === viewId);
    if (!view) throw new Error(`主视图不存在: ${viewId}。请重新读取工作区，不会回退到活动窗口。`);
    return view;
  }

  inspect(viewId: string, signal?: AbortSignal): Promise<ToolResult> {
    identifier(viewId);
    return this.serial(async s => {
      const target = this.target(await this.readWorkspace(s), viewId);
      const stats = await this.connection.call("get_image_statistics", { viewId }, s);
      return this.result(JSON.stringify(target, null, 2) + "\n" + resultText(stats), { target });
    }, signal);
  }

  parameters(processId: string, signal?: AbortSignal): Promise<ToolResult> {
    identifier(processId);
    return this.serial(async s => {
      await requireLive(this.config);
      const result = await this.connection.call("get_process_parameters", { processId }, s);
      return this.result(resultText(result), { processId, executable: (ALLOWED_PROCESSES as readonly string[]).includes(processId) });
    }, signal);
  }

  preview(viewId: string, stf: "auto" | "asis" | "view", rect: number[] | undefined, ui: Interaction, signal?: AbortSignal): Promise<ToolResult> {
    identifier(viewId);
    return this.serial(async s => {
      if (!ui.hasUI) throw new Error("发送图像需要交互确认；print/JSON 模式不自动上传预览");
      const view = this.target(await this.readWorkspace(s), viewId);
      if (rect && (rect.length !== 4 || rect.some(v => !Number.isInteger(v)) || rect[0] < 0 || rect[1] < 0 || rect[2] > view.width || rect[3] > view.height || rect[2] <= rect[0] || rect[3] <= rect[1])) throw new Error("无效的裁剪范围 [x0,y0,x1,y1]");
      const w = rect ? rect[2] - rect[0] : view.width;
      const h = rect ? rect[3] - rect[1] : view.height;
      const downsample = Math.max(1, Math.ceil(Math.max(w, h) / 1600));
      if (downsample > 16) throw new Error("图像过大，请选择局部裁剪区域");
      if (!await ui.confirm("发送 PixInsight 图像预览？", `将 ${viewId} 的 PNG 预览发送给当前模型（可能是云端服务）。显示模式: ${stf}；不会对源像素应用拉伸。`, s)) throw new Error("用户取消预览上传");
      s.throwIfAborted();
      const current = this.target(await this.readWorkspace(s), viewId);
      if (JSON.stringify(view) !== JSON.stringify(current)) throw new Error("确认期间预览目标发生变化，请重新确认");
      const dir = join(this.config.stateDir, "artifacts");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `${randomUUID()}.png`);
      const render = await this.connection.call("render_view", { viewId, outputPath: path, stf, ...(rect ? { rect } : {}), downsample }, s);
      const metadata = JSON.parse(resultText(render));
      if (typeof metadata.path !== "string" || resolve(metadata.path) !== path) throw new Error("渲染返回了非请求的文件路径，拒绝读取");
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new Error("预览文件无效或超过 16MB");
      await chmod(path, 0o600);
      const png = await readFile(path);
      if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("预览不是有效的 PNG 文件");
      s.throwIfAborted();
      return {
        content: [
          { type: "text", text: JSON.stringify({ ...metadata, note: "这是显示预览，不是原始浮点数据；STF 不代表源图已非线性化。" }, null, 2) },
          { type: "image", data: png.toString("base64"), mimeType: "image/png" },
        ],
        details: { preview: metadata },
      };
    }, signal);
  }

  runProcess(processId: string, viewId: string, settings: Record<string, unknown>, ui: Interaction, signal?: AbortSignal): Promise<ToolResult> {
    identifier(viewId);
    if (!(ALLOWED_PROCESSES as readonly string[]).includes(processId)) throw new Error(`本版未开放 ${processId}。允许: ${ALLOWED_PROCESSES.join(", ")}`);
    validateSettings(settings);
    return this.serial(async s => {
      if (!this.writesEnabled || !ui.hasUI) throw new Error("修改操作默认关闭。请用户运行 /pixinsight writes on；每次执行仍需交互确认");
      if (await this.pending()) throw new Error(`存在未确认完成的操作，禁止自动重试。请检查 PI 和 ${this.lockPath}，再由用户执行 /pixinsight recover`);
      const before = this.target(await this.readWorkspace(s), viewId);
      if (!await ui.confirm("确认直接处理这个主视图？", `实例 ${this.config.instance} / ${viewId}\nProcess: ${processId}\n参数: ${JSON.stringify(settings, null, 2)}\n\n这会直接修改目标或生成衍生图像，不会自动克隆；请先在 PI 中创建副本。不会自动保存或关闭窗口。取消等待不等于取消 PI 中的处理。`, s)) throw new Error("用户取消处理");
      s.throwIfAborted();
      const current = this.target(await this.readWorkspace(s), viewId);
      if (JSON.stringify(before) !== JSON.stringify(current)) throw new Error("确认期间目标状态发生变化，请重新检查并确认。尚未执行处理");
      if (!this.writesEnabled) throw new Error("写权限已被撤销，尚未执行处理");
      const operation: PendingOperation = { id: randomUUID(), instance: this.config.instance, bridgeDir: this.config.bridgeDir, processId, viewId, settings, startedAt: new Date().toISOString() };
      await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
      // 原子、跨会话的保守写锁。取消、超时、连接错误或结果不确定时保留。
      await writeFile(this.lockPath, JSON.stringify(operation, null, 2), { mode: 0o600, flag: "wx" }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("另一个会话有未完成的写操作，拒绝并发执行");
        throw error;
      });
      const audit = async (stage: string, extra = {}) => appendFile(join(this.config.stateDir, "operations.jsonl"), JSON.stringify({ ...operation, stage, recordedAt: new Date().toISOString(), ...extra }) + "\n", { mode: 0o600 });
      let executed: McpResult;
      try {
        await audit("dispatching");
        s.throwIfAborted();
        if (!this.writesEnabled) throw new Error("写权限已被撤销，尚未投递处理命令");
        executed = await this.connection.call("run_process", { processId, viewId, settings }, s);
        await audit("succeeded", { result: resultText(executed) });
        await unlink(this.lockPath);
      } catch (error) {
        await audit("unknown", { error: String(error) }).catch(() => {});
        throw new Error(`处理结果不确定，已保留恢复锁；不要自动重试。取消/超时不代表 PI 已停止。${String(error)}`);
      }
      this.workspaceCache = undefined;
      let verification: unknown;
      try {
        await requireLive(this.config);
        const stats = await this.connection.call("get_image_statistics", { viewId }, s);
        verification = { statistics: resultText(stats) };
      } catch (error) { verification = { error: String(error), note: "处理已返回成功，但后续测量失败；不要重复执行处理" }; }
      return this.result(resultText(executed) + "\n" + JSON.stringify({ verification }, null, 2), { operation, executionSucceeded: true, verification });
    }, signal);
  }

  recover(ui: Interaction): Promise<void> {
    return this.serial(async s => {
      if (!ui.hasUI) throw new Error("恢复写锁需要用户交互确认");
      const pending = await this.pending();
      if (!pending) return;
      const checkQueue = async () => {
        const entries = await readdir(join(this.config.bridgeDir, "commands")).catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
          throw error;
        });
        if (entries.some(n => n.endsWith(".json"))) throw new Error("桥接队列仍有待处理命令，不能解除写锁。先在 PI/桥接端查明并处理，不要盲目删除");
      };
      await checkQueue();
      if (!await ui.confirm("确认解除不确定操作的写锁？", `${pending.processId} → ${pending.viewId}\n请先确认 PI 中任务已经结束/停止，并检查图像结果。解除锁不会撤回或回滚任何操作。`, s)) throw new Error("用户取消恢复");
      s.throwIfAborted();
      await checkQueue();
      await unlink(this.lockPath);
      this.writesEnabled = false;
      this.workspaceCache = undefined;
    });
  }

  async close(): Promise<void> {
    this.writesEnabled = false;
    this.lifecycle.abort(new Error("pi 会话已结束；并不意味着 PI 中的处理停止"));
    await this.connection.close();
  }
}
