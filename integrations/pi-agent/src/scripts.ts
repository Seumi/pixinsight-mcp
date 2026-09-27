// 仅供适配器内部使用的固定只读脚本；不接收模型提供的代码。
export const WORKSPACE_SCRIPT = `(function(){
  function optional(fn) { try { return fn(); } catch(e) { return null; } }
  var aw = ImageWindow.activeWindow;
  var active = (!aw || aw.isNull) ? null : aw.currentView.fullId;
  var windows = ImageWindow.windows;
  var images = [];
  for (var i = 0; i < windows.length; ++i) {
    var w = windows[i], v = w.mainView, im = v.image;
    images.push({
      id: v.id, width: im.width, height: im.height,
      channels: im.numberOfChannels, bitsPerSample: im.bitsPerSample,
      isReal: im.isReal, isColor: im.isColor, filePath: w.filePath || null,
      historyIndex: optional(function(){ return v.historyIndex; }),
      stf: optional(function(){ return v.stf; }),
      maskId: optional(function(){ return w.mask.isNull ? null : w.mask.mainView.id; }),
      maskEnabled: optional(function(){ return w.maskEnabled; }),
      maskInverted: optional(function(){ return w.maskInverted; }),
      previews: optional(function(){ return w.previews.map(function(p){ return p.fullId; }); }),
      linearState: "unknown"
    });
  }
  return JSON.stringify({ instance: CoreApplication.instance, activeViewId: active, images: images });
})()`;

export interface ImageInfo {
  id: string;
  width: number;
  height: number;
  channels: number;
  bitsPerSample: number;
  isReal: boolean;
  isColor: boolean;
  filePath: string | null;
  historyIndex: number | null;
  stf?: unknown;
  maskId?: string | null;
  maskEnabled?: boolean | null;
  maskInverted?: boolean | null;
  previews?: string[] | null;
  linearState: "unknown";
}

export interface Workspace {
  instance: number;
  activeViewId: string | null;
  images: ImageInfo[];
  capturedAt: string;
}

export function identifier(id: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) throw new Error("请输入完整主视图 ID（字母、数字、下划线），本版不处理 preview 或表达式目标");
}
