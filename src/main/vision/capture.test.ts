import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createVisionCapture,
  matchWindowSource,
  thumbnailSizeFor,
  type CapturePlatform,
  type DesktopSourceLike,
  type DisplayLike,
  type NativeImageLike,
} from './capture';

class FakeImage implements NativeImageLike {
  constructor(
    public width: number,
    public height: number,
    private readonly empty = false,
  ) {}

  isEmpty(): boolean {
    return this.empty;
  }

  getSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  resize(options: { width?: number; height?: number }): NativeImageLike {
    return new FakeImage(options.width ?? this.width, options.height ?? this.height);
  }

  toPNG(): Buffer {
    return Buffer.from(`PNG:${this.width}x${this.height}`);
  }
}

function source(
  id: string,
  name: string,
  displayId: string,
  width = 2400,
  height = 1500,
  empty = false,
): DesktopSourceLike {
  return { id, name, display_id: displayId, thumbnail: new FakeImage(width, height, empty) };
}

const DISPLAY: DisplayLike = { id: 7, size: { width: 1600, height: 1000 }, scaleFactor: 1.5 };

function platform(options: {
  sources?: DesktopSourceLike[];
  throwOnSources?: boolean;
}): CapturePlatform {
  return {
    async getSources() {
      if (options.throwOnSources) throw new Error('capture disabled');
      return options.sources ?? [source('screen:0:0', 'Entire screen', '7')];
    },
    getCursorScreenPoint() {
      return { x: 10, y: 10 };
    },
    getDisplayNearestPoint() {
      return DISPLAY;
    },
    getPrimaryDisplay() {
      return DISPLAY;
    },
  };
}

test('ADR 0054 D2：整屏截图按 display_id 选源、超宽等比缩放并返回 PNG 元信息', async () => {
  const capture = createVisionCapture(platform({}));
  const result = await capture.capture({ source: 'screen', maxWidth: 800 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.capturedFrom, 'screen');
  assert.equal(result.width, 800);
  assert.equal(result.height, 500);
  assert.equal(result.png.toString(), 'PNG:800x500');
  assert.ok(result.capturedAt > 0);
});

test('ADR 0054 D2.3：前台窗口标题匹配成功 → 用窗口源；匹配不到 → 静默降级整屏', async () => {
  const capture = createVisionCapture(
    platform({
      sources: [
        source('window:123:0', 'Visual Studio Code', ''),
        source('screen:0:0', 'Entire screen', '7'),
      ],
    }),
  );

  const matched = await capture.capture({
    source: 'foreground',
    foregroundTitle: 'Visual Studio Code - aa3dpet-app',
    maxWidth: 1600,
  });
  assert.equal(matched.ok, true);
  if (matched.ok) {
    assert.equal(matched.capturedFrom, 'foreground');
    assert.equal(matched.sourceTitle, 'Visual Studio Code');
  }

  const fallback = await capture.capture({
    source: 'foreground',
    foregroundTitle: 'Notepad',
    maxWidth: 1600,
  });
  assert.equal(fallback.ok, true);
  if (fallback.ok) assert.equal(fallback.capturedFrom, 'screen');
});

test('ADR 0054 D5：空缩略图 / getSources 抛错 / 无源 都返回失败对象（不抛）', async () => {
  const empty = createVisionCapture(
    platform({ sources: [source('screen:0:0', 'Entire screen', '7', 100, 100, true)] }),
  );
  const emptyResult = await empty.capture({ source: 'screen', maxWidth: 1600 });
  assert.equal(emptyResult.ok, false);
  if (!emptyResult.ok) assert.equal(emptyResult.reason, 'empty');

  const thrown = createVisionCapture(platform({ throwOnSources: true }));
  const thrownResult = await thrown.capture({ source: 'screen', maxWidth: 1600 });
  assert.equal(thrownResult.ok, false);
  if (!thrownResult.ok) {
    assert.equal(thrownResult.reason, 'unavailable');
    assert.match(thrownResult.detail, /capture disabled/);
  }

  const none = createVisionCapture(platform({ sources: [] }));
  const noneResult = await none.capture({ source: 'screen', maxWidth: 1600 });
  assert.equal(noneResult.ok, false);
  if (!noneResult.ok) assert.equal(noneResult.reason, 'unavailable');
});

test('ADR 0054 D2.2：标题匹配只认 ≥3 字符，且不匹配自己传入的短标题', () => {
  const sources = [source('window:1:0', 'Entire screen', '')];
  assert.equal(matchWindowSource(sources, 'ab'), null);
  assert.equal(matchWindowSource(sources, 'entire screen'), sources[0]);
  assert.equal(matchWindowSource(sources, null), null);
});

test('ADR 0054 D2.1：缩略图请求尺寸受硬上限约束且保持宽高比', () => {
  const size = thumbnailSizeFor(
    { id: 1, size: { width: 3840, height: 2160 }, scaleFactor: 1 },
    2560,
  );
  assert.deepEqual(size, { width: 2560, height: 1440 });
  const highDpi = thumbnailSizeFor(
    { id: 2, size: { width: 1600, height: 1000 }, scaleFactor: 2 },
    2560,
  );
  assert.deepEqual(highDpi, { width: 2560, height: 1600 });
});
