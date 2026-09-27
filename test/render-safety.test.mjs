// 在 Node vm 中执行生成的 PJSR；不连接 PixInsight，也不创建实际图像文件。
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderScript } from "../build/pjsr/render.js";

const outputPath = join(tmpdir(), "render-safety-output.png");
const plain = (value) => JSON.parse(JSON.stringify(value));
const identitySTF = Array.from({ length: 4 }, () => [0.5, 0, 1, 0, 1]);

class Rect {
  constructor(x0, y0, x1, y1) { Object.assign(this, { x0, y0, x1, y1 }); }
}

function selection(image) {
  const { x0, y0, x1, y1 } = image.selectedRect;
  return {
    rect: [x0, y0, x1, y1],
    channels: [image.firstSelectedChannel, image.lastSelectedChannel],
    point: [image.selectedPoint.x, image.selectedPoint.y],
    clipping: image.rangeClippingEnabled,
    range: [image.rangeClipLow, image.rangeClipHigh],
  };
}

function restore(image, state) {
  image.selectedRect = new Rect(...state.rect);
  [image.firstSelectedChannel, image.lastSelectedChannel] = state.channels;
  image.selectedPoint = { x: state.point[0], y: state.point[1] };
  image.rangeClippingEnabled = state.clipping;
  [image.rangeClipLow, image.rangeClipHigh] = state.range;
}

function mockPjsr(options = {}) {
  const viewId = options.viewId ?? "source";
  const events = [], statistics = [], assignments = [], saved = [], transforms = [], created = [];
  const queried = [], closed = [];
  const operation = (stage) => {
    events.push(stage);
    if (options.fail === stage) throw new Error(`mock ${stage} failed`);
    return options.fail !== `${stage}-false`;
  };
  const full = {
    rect: [0, 0, 120, 80], channels: [0, 2], point: [0, 0], clipping: false, range: [0, 1],
  };
  const source = {
    width: 120, height: 80, numberOfChannels: 3, isColor: true,
    // 模拟调用者已有的选区栈，不能被本次渲染清空或弹出。
    stack: [plain(full)], pushes: 0, pops: 0,
    get selectedChannel() { return this.firstSelectedChannel; },
    set selectedChannel(channel) {
      this.firstSelectedChannel = this.lastSelectedChannel = channel;
    },
    pushSelections() { ++this.pushes; this.stack.push(selection(this)); },
    popSelections() { ++this.pops; restore(this, this.stack.pop()); },
    resetSelections() { restore(this, full); operation("reset"); },
    median() {
      statistics.push({ kind: "median", ...selection(this) });
      operation("median");
      return options.degenerate ? 0.001 : 0.25 + this.selectedChannel * 0.01;
    },
    MAD() {
      statistics.push({ kind: "MAD", ...selection(this) });
      operation("MAD");
      return 0.02 + this.selectedChannel * 0.001;
    },
  };
  restore(source, {
    rect: [12, 17, 37, 41], channels: [1, 2], point: [8, 13], clipping: true, range: [0.17, 0.83],
  });
  const initial = selection(source);
  const initialStack = plain(source.stack);
  const assertSource = () => {
    assert.deepEqual(selection(source), initial, "源图像的完整选区必须恢复");
    assert.deepEqual(source.stack, initialStack, "调用者原有的选区栈必须保留");
    assert.deepEqual([source.width, source.height, source.numberOfChannels], [120, 80, 3]);
  };
  const view = {
    image: source, isNull: false,
    get stf() { operation("stf"); return options.stf ?? identitySTF; },
  };
  const registry = new Map();
  for (const id of new Set([viewId, "mcp_render_tmp", "mcp_render_tmp_1", "mcp_render_tmp_3"])) {
    registry.set(id, {
      isNull: false,
      forceClose() { closed.push(id); registry.delete(id); this.isNull = true; },
    });
  }
  const originalWindows = new Map(registry);

  class ImageWindow {
    static windowById(id) {
      operation("lookup"); queried.push(id);
      return registry.get(id) ?? { isNull: true };
    }
    constructor(width, height, channels, bits, floating, color, id) {
      operation("create");
      this.isNull = options.fail === "create-null";
      if (this.isNull) return;
      assert.equal(registry.has(id), false, "新窗口 ID 必须未占用");
      assert.deepEqual([bits, floating, color], [32, true, true]);
      Object.assign(this, { id, begins: 0, ends: 0, depth: 0, closes: 0 });
      const window = this;
      this.view = {
        beginProcess() {
          operation("begin");
          assert.equal(window.depth, 0);
          ++window.begins; ++window.depth;
        },
        endProcess() {
          assert.equal(window.depth, 1, "endProcess 只能对应成功的 beginProcess");
          ++window.ends; --window.depth;
          operation("end");
        },
        image: {
          width, height, numberOfChannels: channels,
          // 与 PJSR 一致：assign 根据源矩形和通道选区复制，而非无条件复制全图。
          assign(image) {
            assert.equal(window.depth, 1);
            assert.equal(image, source);
            const state = selection(image);
            assignments.push(state);
            this.width = state.rect[2] - state.rect[0];
            this.height = state.rect[3] - state.rect[1];
            this.numberOfChannels = state.channels[1] - state.channels[0] + 1;
            operation("assign");
          },
          render() {
            assert.equal(window.depth, 0);
            assertSource(); operation("render");
            return {
              save: (path, quality) => {
                assertSource();
                saved.push({ path, quality, width: this.width, height: this.height });
                return operation("save");
              },
            };
          },
        },
      };
      created.push(this); registry.set(id, this);
    }
    get mainView() { operation("mainView"); return this.view; }
    forceClose() {
      assertSource();
      assert.equal(this.depth, 0, "关闭前必须结束处理");
      ++this.closes; closed.push(this.id);
      registry.delete(this.id); this.isNull = true;
    }
  }
  const assertTarget = (target) => {
    assertSource();
    assert.ok(created.some((window) => window.view === target && window.depth === 0));
  };
  class HistogramTransformation {
    executeOn(target) {
      assertTarget(target); transforms.push(plain(this.H));
      return operation("histogram");
    }
  }
  class IntegerResample {
    executeOn(target) {
      assertTarget(target);
      if (!operation("resample")) return false;
      target.image.width = Math.floor(target.image.width / -this.zoomFactor);
      target.image.height = Math.floor(target.image.height / -this.zoomFactor);
      return true;
    }
  }
  return {
    source, full, created, statistics, assignments, saved, transforms, queried, closed, events,
    run(mode = "asis", rect, downsample, quality) {
      const script = renderScript(viewId, outputPath, mode, rect, downsample, quality);
      return JSON.parse(vm.runInNewContext(script, {
        View: { viewById: () => options.missing ? { isNull: true } : view },
        ImageWindow, Rect, HistogramTransformation, IntegerResample,
      }, { timeout: 1000 }));
    },
    assertClean(expectedCreated = 1) {
      assertSource();
      assert.equal(source.pushes, 1); assert.equal(source.pops, 1);
      assert.equal(created.length, expectedCreated);
      for (const window of created) {
        assert.equal(window.begins, window.ends);
        assert.equal(window.depth, 0); assert.equal(window.closes, 1);
      }
      assert.deepEqual(registry, originalWindows, "用户原有窗口不得被替换或关闭");
      assert.deepEqual(closed, created.map((window) => window.id));
    },
  };
}

for (const viewId of ["source", "mcp_render_tmp"]) {
  test(`临时 ID 跳过所有已占用窗口，源 ID=${viewId}`, () => {
    const mock = mockPjsr({ viewId });
    mock.run();
    assert.deepEqual(mock.queried, ["mcp_render_tmp", "mcp_render_tmp_1", "mcp_render_tmp_2"]);
    assert.deepEqual(mock.closed, ["mcp_render_tmp_2"]);
    mock.assertClean();
  });
}

for (const mode of ["asis", "auto", "view"]) {
  for (const rect of [undefined, [5.4, -8, 97.6, 100]]) {
    test(`${mode} ${rect ? "显式裁剪" : "无 rect"}：恢复完整选区，忽略原有裁剪`, () => {
      const mock = mockPjsr();
      const result = mock.run(mode, rect);
      const expectedRect = rect ? [5, 0, 98, 80] : mock.full.rect;
      assert.deepEqual(result.sourceRect, expectedRect);
      assert.deepEqual([result.width, result.height], [expectedRect[2] - expectedRect[0], 80]);
      assert.deepEqual(mock.assignments, [{ ...mock.full, rect: expectedRect }]);
      assert.equal(mock.created[0].view.image.numberOfChannels, 3);
      mock.assertClean();
    });
  }
}

test("成功返回结构和默认渲染参数保持不变", () => {
  const mock = mockPjsr();
  assert.deepEqual(mock.run(), {
    viewId: "source", path: outputPath, width: 120, height: 80,
    stfMode: "asis", stfApplied: false, stretch: null,
    sourceRect: [0, 0, 120, 80], downsample: 1, warnings: [],
  });
  assert.deepEqual(mock.saved, [{ path: outputPath, quality: 100, width: 120, height: 80 }]);
  mock.assertClean();
});

test("auto 对完整图逐通道统计，保持现有拉伸公式，再裁剪及降采样", () => {
  const mock = mockPjsr();
  const result = mock.run("auto", [10, 20, 110, 80], 2.8, 83.9);
  assert.deepEqual(mock.statistics, [0, 1, 2].flatMap((channel) =>
    ["median", "MAD"].map((kind) => ({ ...mock.full, kind, channels: [channel, channel] }))));
  const med = [0.25, 0.26, 0.27].reduce((sum, value) => sum + value / 3, 0);
  const mad = [0.02, 0.021, 0.022].reduce((sum, value) => sum + value / 3, 0);
  const c0 = med - 2.8 * 1.4826 * mad;
  const x = med - c0;
  const m = ((0.25 - 1) * x) / (((2 * 0.25 - 1) * x) - 0.25);
  assert.deepEqual(result.stretch, { 3: [c0, m, 1] });
  assert.deepEqual(mock.transforms[0][3], [c0, m, 1, 0, 1]);
  assert.deepEqual([result.width, result.height, result.downsample], [50, 30, 2]);
  assert.deepEqual(mock.saved, [{ path: outputPath, quality: 83, width: 50, height: 30 }]);
  assert.ok(mock.events.indexOf("assign") < mock.events.indexOf("histogram"));
  assert.ok(mock.events.indexOf("histogram") < mock.events.indexOf("resample"));
  mock.assertClean();
});

test("保留退化中值保护及警告", () => {
  const mock = mockPjsr({ degenerate: true });
  const result = mock.run("auto");
  assert.deepEqual(result.stretch, { 3: [0, 0.01, 1] });
  assert.match(result.warnings[0], /degenerate-median/);
  mock.assertClean();
});

test("view STF 的行转换及 identity 警告保持不变", () => {
  const stf = [[0.31, 0.04, 0.9, 0, 1], [0.4, 0.03, 0.95, 0, 1], [0.22, 0.06, 0.88, 0, 1]];
  const mock = mockPjsr({ stf });
  const result = mock.run("view");
  assert.deepEqual(result.stretch, { 0: [0.04, 0.31, 0.9], 1: [0.03, 0.4, 0.95], 2: [0.06, 0.22, 0.88] });
  mock.assertClean();
  const identity = mockPjsr();
  const unchanged = identity.run("view");
  assert.equal(unchanged.stfApplied, false);
  assert.deepEqual(unchanged.warnings, ["view has no STF set - rendering as-is"]);
  identity.assertClean();
});

for (const fail of ["reset", "median", "MAD", "stf", "lookup", "create", "create-null"]) {
  test(`${fail} 失败：恢复选区且不关闭任何原有窗口`, () => {
    const mock = mockPjsr({ fail });
    assert.throws(() => mock.run(fail === "stf" ? "view" : "auto"),
      fail === "create-null" ? /Failed to create render window/ : new RegExp(`mock ${fail} failed`));
    mock.assertClean(0);
  });
}

for (const fail of ["mainView", "begin", "assign", "end", "histogram", "resample", "render", "save"]) {
  test(`${fail} 抛错：只清理自己的窗口并配对 begin/endProcess`, () => {
    const mock = mockPjsr({ fail });
    assert.throws(() => mock.run("auto", [10, 20, 110, 80], 2), new RegExp(`mock ${fail} failed`));
    assert.equal(mock.created[0].begins, ["mainView", "begin"].includes(fail) ? 0 : 1);
    mock.assertClean();
  });
}

for (const [fail, message] of [
  ["histogram-false", /HistogramTransformation failed/],
  ["resample-false", /IntegerResample failed/],
  ["save-false", /Failed to save rendered image/],
]) {
  test(`${fail}：不得返回成功，必须恢复选区并关闭临时窗口`, () => {
    const mock = mockPjsr({ fail });
    assert.throws(() => mock.run("auto", undefined, 2), message);
    mock.assertClean();
  });
}

test("找不到源图像时保留原有错误返回，且不创建窗口或修改选区", () => {
  const mock = mockPjsr({ missing: true });
  assert.deepEqual(mock.run(), { error: "Image not found: source" });
  assert.equal(mock.source.pushes, 0); assert.equal(mock.source.pops, 0);
  assert.deepEqual(mock.closed, []); assert.deepEqual(mock.created, []);
});
