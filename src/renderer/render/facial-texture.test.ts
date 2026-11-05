import assert from 'node:assert/strict';
import test from 'node:test';
import { EMOTIONS } from '../../shared/emotions';
import {
  DEFAULT_PALETTE,
  EMOTION_FACE,
  EMOTION_FADE_MS,
  WALK_YAW_RAD,
  approach,
  ellipseValue,
  fadeProgress,
  resolveMouthOwner,
  sampleMouthShape,
  walkYawFor,
} from './emotion-face';
import type { EyeAssetKey } from './emotion-face';
import {
  BLUSH_ASSET_FILE,
  EYE_ASSET_FILES,
  PAIR_ASPECT,
  blushStrength,
  eyeCropRect,
  localToUv,
  resolveEyeCrop,
  sampleBlushImagePacked,
  sampleEyeImagePacked,
} from './expression-assets';
import type { PixelImage } from './expression-assets';
import {
  CH0335_MOUTH_LAYOUT,
  atlasFrameIndex,
  buildSurface,
  clusterEyes,
  dedupeSurfaces,
  deriveCheekAnchors,
  isPlateTriangle,
  percentileRange,
  trianglesBounds,
} from './facial-texture';
import type { UvTriangle } from './facial-texture';
import { MOUTH_FRAME_CLOSED } from '../../shared/constants';

function assertClose(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);
}

function triangle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, uv = 0): UvTriangle {
  return {
    ax,
    ay,
    au: uv,
    av: uv,
    bx,
    by,
    bu: uv,
    bv: uv,
    cx,
    cy,
    cu: uv,
    cv: uv,
  };
}

/** 造一张合成贴图：`fill(x, y)` 返回 RGBA。 */
function makeImage(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number, number],
): PixelImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = fill(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = a;
    }
  }
  return { width, height, data };
}

function unpack(packed: number): { r: number; g: number; b: number; a: number } {
  return {
    r: (packed >>> 24) & 0xff,
    g: (packed >>> 16) & 0xff,
    b: (packed >>> 8) & 0xff,
    a: (packed & 0xff) / 255,
  };
}

// ---------------------------------------------------------------------------
// 1. emotion → 资产映射（本轮的核心：眼型只能来自官方差分）
// ---------------------------------------------------------------------------

test('EMOTION_FACE 覆盖 §4.5 的每一个 emotion，没有多余键', () => {
  assert.deepEqual(Object.keys(EMOTION_FACE).sort(), [...EMOTIONS].sort());
  const allowedEyes: Array<EyeAssetKey | null> = ['happy', 'shy', 'sad', 'surprised', null];
  for (const emotion of EMOTIONS) {
    const face = EMOTION_FACE[emotion];
    assert.ok(face, `${emotion} 缺少映射`);
    assert.ok(allowedEyes.includes(face.eyes), `${emotion} 的 eyes 非法：${String(face.eyes)}`);
    assert.ok(['none', 'smile', 'frown', 'open', 'small'].includes(face.mouth));
    assert.ok([0, 1, 2].includes(face.blush));
  }
});

test('情绪语义：happy/shy/sad/surprised 各自绑定官方眼型；angry 无眼型 → 只变嘴', () => {
  assert.equal(EMOTION_FACE.happy.eyes, 'happy');
  assert.equal(EMOTION_FACE.happy.mouth, 'smile');
  assert.equal(EMOTION_FACE.happy.blush, 1);

  assert.equal(EMOTION_FACE.shy.eyes, 'shy');
  assert.equal(EMOTION_FACE.shy.blush, 2);
  assert.ok(EMOTION_FACE.shy.blush > EMOTION_FACE.happy.blush);

  assert.equal(EMOTION_FACE.sad.eyes, 'sad');
  assert.equal(EMOTION_FACE.sad.mouth, 'frown');

  assert.equal(EMOTION_FACE.surprised.eyes, 'surprised');
  assert.equal(EMOTION_FACE.surprised.mouth, 'open');

  // 素材里没有"生气"眼型 → 必须降级，而不是拿别的眼型冒充
  assert.equal(EMOTION_FACE.angry.eyes, null);
  assert.notEqual(EMOTION_FACE.angry.mouth, 'none');

  assert.equal(EMOTION_FACE.neutral.eyes, null);
  assert.equal(EMOTION_FACE.neutral.mouth, 'none');
  assert.equal(EMOTION_FACE.neutral.blush, 0);
});

test('资产文件名固定且可枚举（不接受任意路径）', () => {
  assert.deepEqual(Object.keys(EYE_ASSET_FILES).sort(), ['happy', 'sad', 'shy', 'surprised']);
  for (const file of Object.values(EYE_ASSET_FILES)) {
    assert.match(file, /^eyes_[a-z]+\.png$/);
  }
  assert.equal(BLUSH_ASSET_FILE, 'blush.png');
});

// ---------------------------------------------------------------------------
// 2. 眼型图的裁剪规则（单眼 / 双眼条）
// ---------------------------------------------------------------------------

test('宽高比 ≥ 1.6 视为双眼条，否则单眼；非法尺寸按单眼', () => {
  assert.equal(PAIR_ASPECT, 1.6);
  assert.equal(resolveEyeCrop(128, 128), 'single');
  assert.equal(resolveEyeCrop(256, 128), 'pair');
  assert.equal(resolveEyeCrop(160, 100), 'pair'); // 1.6 边界
  assert.equal(resolveEyeCrop(159, 100), 'single');
  assert.equal(resolveEyeCrop(0, 128), 'single');
  assert.equal(resolveEyeCrop(128, 0), 'single');
});

test('双眼条按左右半裁剪，单眼图两只眼共用整张', () => {
  const image = makeImage(40, 20, () => [0, 0, 0, 255]);
  assert.deepEqual(eyeCropRect(image, 'single', 0), { x: 0, y: 0, width: 40, height: 20 });
  assert.deepEqual(eyeCropRect(image, 'single', 1), { x: 0, y: 0, width: 40, height: 20 });
  assert.deepEqual(eyeCropRect(image, 'pair', 0), { x: 0, y: 0, width: 20, height: 20 });
  assert.deepEqual(eyeCropRect(image, 'pair', 1), { x: 20, y: 0, width: 20, height: 20 });
});

test('局部坐标 → UV：ex 左 −1 右 +1，ey 下 −1 上 +1（贴图 y 向下）', () => {
  assert.deepEqual(localToUv(-1, 1), [0, 0]);
  assert.deepEqual(localToUv(1, -1), [1, 1]);
  assert.deepEqual(localToUv(0, 0), [0.5, 0.5]);
});

// ---------------------------------------------------------------------------
// 3. 眼型 / 红晕贴图采样（纯函数，用合成缓冲验证）
// ---------------------------------------------------------------------------

test('单眼图：两只眼取到同一图案；左半红右半蓝时按 ex 取值', () => {
  const image = makeImage(4, 4, (x) => (x < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
  const left = unpack(sampleEyeImagePacked(image, 'single', -1, -0.5, 0));
  const right = unpack(sampleEyeImagePacked(image, 'single', 1, 0.5, 0));
  assert.equal(left.r, 255);
  assert.equal(left.b, 0);
  assert.equal(right.b, 255);
  assert.equal(right.r, 0);
});

test('双眼条：同一局部坐标在左右两个半边取到不同颜色', () => {
  const image = makeImage(8, 4, (x) => (x < 4 ? [10, 20, 30, 255] : [200, 210, 220, 255]));
  const leftEye = unpack(sampleEyeImagePacked(image, 'pair', -1, 0, 0));
  const rightEye = unpack(sampleEyeImagePacked(image, 'pair', 1, 0, 0));
  assert.deepEqual([leftEye.r, leftEye.g, leftEye.b], [10, 20, 30]);
  assert.deepEqual([rightEye.r, rightEye.g, rightEye.b], [200, 210, 220]);
});

test('透明像素不画；越界坐标返回 0（不抛）', () => {
  const image = makeImage(4, 4, () => [255, 255, 255, 0]);
  assert.equal(sampleEyeImagePacked(image, 'single', -1, 0, 0), 0);
  assert.equal(sampleEyeImagePacked(image, 'single', -1, 2, 0), 0);
  assert.equal(sampleEyeImagePacked(image, 'single', -1, 0, -3), 0);
});

test('官方差分自带的 alpha 被保留（柔边能透出原贴图）', () => {
  const image = makeImage(4, 4, () => [255, 255, 255, 128]);
  const sampled = unpack(sampleEyeImagePacked(image, 'single', -1, 0, 0));
  assertClose(sampled.a, 128 / 255, 1 / 255);
});

test('红晕：强度倍率线性缩放 alpha；strength 0 不画；level 2 明显强于 level 1', () => {
  const image = makeImage(4, 4, () => [240, 128, 150, 200]);
  const full = unpack(sampleBlushImagePacked(image, 0, 0, 1));
  const half = unpack(sampleBlushImagePacked(image, 0, 0, 0.5));
  assertClose(full.a, 200 / 255, 1 / 255);
  assertClose(half.a, (200 * 0.5) / 255, 1 / 255);
  assert.equal(sampleBlushImagePacked(image, 0, 0, 0), 0);
  assert.ok(blushStrength(2) > blushStrength(1));
  assert.equal(blushStrength(0), 0);
});

// ---------------------------------------------------------------------------
// 4. 嘴型（唯一保留的程序化图元：一条弧线 / 一个小口，不涉及眼型）
// ---------------------------------------------------------------------------

test('smile 嘴角上扬、frown 嘴角下垂（同一 mx 的线高互为反号）', () => {
  const smileMiddle = sampleMouthShape('smile', 0, -0.34, DEFAULT_PALETTE, 1);
  const smileCorner = sampleMouthShape('smile', 0.8, -0.34, DEFAULT_PALETTE, 1);
  assert.equal(smileMiddle?.r, DEFAULT_PALETTE.ink.r, '中间高度应为墨色');
  assert.equal(smileCorner, null, '同一高度在嘴角处不是线（嘴角更高）');

  const smileCornerHit = sampleMouthShape('smile', 0.8, -0.34 + 0.66 * 0.64, DEFAULT_PALETTE, 1);
  assert.equal(smileCornerHit?.r, DEFAULT_PALETTE.ink.r, '嘴角在该高度上才命中 → 曲线向上');

  const frownCornerHit = sampleMouthShape('frown', 0.8, 0.34 - 0.66 * 0.64, DEFAULT_PALETTE, 1);
  assert.equal(frownCornerHit?.r, DEFAULT_PALETTE.ink.r, '下垂嘴在嘴角处更高 → 曲线向下');
});

test('open / small 是实心椭圆，none 什么都不画', () => {
  assert.equal(sampleMouthShape('none', 0, 0, DEFAULT_PALETTE, 1), null);
  const openCenter = sampleMouthShape('open', 0, 0, DEFAULT_PALETTE, 1);
  assert.equal(openCenter?.r, DEFAULT_PALETTE.mouthInner.r);
  assert.equal(sampleMouthShape('open', 0, 0.9, DEFAULT_PALETTE, 1), null);

  const smallCenter = sampleMouthShape('small', 0, 0, DEFAULT_PALETTE, 1);
  assert.equal(smallCenter?.r, DEFAULT_PALETTE.mouthInner.r);
  assert.ok(sampleMouthShape('open', 0.4, 0, DEFAULT_PALETTE, 1));
  assert.equal(sampleMouthShape('small', 0.4, 0, DEFAULT_PALETTE, 1), null);
});

// ---------------------------------------------------------------------------
// 5. 行走转身（ADR 0026 D1，本轮未改）
// ---------------------------------------------------------------------------

test('行走朝向：右走 +90°、左走 -90°、停下回 0', () => {
  assertClose(walkYawFor('right'), WALK_YAW_RAD);
  assertClose(walkYawFor('left'), -WALK_YAW_RAD);
  assertClose(walkYawFor(null), 0);
  assertClose(WALK_YAW_RAD, Math.PI / 2);
});

test('转身插值：单调逼近目标、不过冲、收敛后吸附', () => {
  let value = 0;
  const target = WALK_YAW_RAD;
  let previous = value;
  for (let i = 0; i < 60; i += 1) {
    value = approach(value, target, 1 / 60, 9);
    assert.ok(value >= previous - 1e-9, '应单调逼近');
    assert.ok(value <= target + 1e-9, '不得过冲');
    previous = value;
  }
  assertClose(value, target, 1e-3);
  for (let i = 0; i < 60; i += 1) value = approach(value, target, 1 / 60, 9);
  assertClose(value, target, 1e-6);

  const oneStep = approach(0, 1, 0.1, 9);
  let twoSteps = approach(0, 1, 0.05, 9);
  twoSteps = approach(twoSteps, 1, 0.05, 9);
  assertClose(oneStep, twoSteps, 1e-9);

  assertClose(approach(0.3, 1, 0, 9), 0.3);
  assertClose(approach(0.3, 1, Number.NaN, 9), 0.3);
});

// ---------------------------------------------------------------------------
// 6. 淡入与嘴层仲裁（§5.2）
// ---------------------------------------------------------------------------

test('淡入：0 起点、250ms 满、越界钳制', () => {
  assertClose(fadeProgress(0), 0);
  assertClose(fadeProgress(EMOTION_FADE_MS / 2), 0.5);
  assertClose(fadeProgress(EMOTION_FADE_MS), 1);
  assertClose(fadeProgress(EMOTION_FADE_MS * 3), 1);
  assertClose(fadeProgress(-5), 0);
});

test('嘴层仲裁：口型永远最高，其次表情，最后静态闭嘴（ADR 0039 D3 删除 pat 归属）', () => {
  const base = { speaking: false, lipSyncDriven: false, emotionMouth: 'smile' as const, alpha: 1 };
  assert.equal(resolveMouthOwner({ ...base, speaking: true }), 'lip-sync');
  assert.equal(resolveMouthOwner({ ...base, lipSyncDriven: true }), 'lip-sync');
  assert.equal(resolveMouthOwner(base), 'emotion');
  assert.equal(resolveMouthOwner({ ...base, emotionMouth: 'none' }), 'static');
  assert.equal(resolveMouthOwner({ ...base, alpha: 0 }), 'static');
});

test('静态闭嘴：必须画到图集的"闭嘴"帧（7），不能因为 frameCount=1 被夹成 0 号细线（ADR 0045 D4.1）', () => {
  const { columns, rows, staticFrameIndex } = CH0335_MOUTH_LAYOUT;
  assert.equal(staticFrameIndex, MOUTH_FRAME_CLOSED, '布局的静态帧与口型的闭嘴帧必须同源');
  assert.equal(staticFrameIndex, 0, 'ADR 0046 D3.2：闭嘴用 0 号平直细线');

  // 旧 bug：frameCount 传 1 → 任何帧号都被夹成 0
  assert.equal(atlasFrameIndex(staticFrameIndex, 1, columns, rows), 0);
  // 正确用法：传真实帧数 → 落到 7
  assert.equal(atlasFrameIndex(staticFrameIndex, columns * rows, columns, rows), MOUTH_FRAME_CLOSED);
  // 越界钳制 / 非法输入
  assert.equal(atlasFrameIndex(-3, columns * rows, columns, rows), 0);
  assert.equal(atlasFrameIndex(999, columns * rows, columns, rows), columns * rows - 1);
  assert.equal(atlasFrameIndex(Number.NaN, columns * rows, columns, rows), 0);
  assert.equal(atlasFrameIndex(6, 8, columns, rows), 6, '不足一行的帧数也要按真实帧数夹取');
});

// ---------------------------------------------------------------------------
// 7. 几何工具：UV 岛分流、眼睛聚类、颊部锚点、表面去重
// ---------------------------------------------------------------------------

test('isPlateTriangle 按 UV 质心区分"嘴部底板"与"眼睛"', () => {
  const plate = CH0335_MOUTH_LAYOUT.plateUv;
  const inside: UvTriangle = {
    ax: plate.x + 0.01, ay: plate.y + 0.01, au: plate.x + 0.01, av: plate.y + 0.01,
    bx: plate.x + 0.05, by: plate.y + 0.05, bu: plate.x + 0.05, bv: plate.y + 0.05,
    cx: plate.x + 0.09, cy: plate.y + 0.09, cu: plate.x + 0.09, cv: plate.y + 0.09,
  };
  const outside: UvTriangle = {
    ax: 0.6, ay: 0.4, au: 0.6, av: 0.4,
    bx: 0.7, by: 0.5, bu: 0.7, bv: 0.5,
    cx: 0.65, cy: 0.6, cu: 0.65, cv: 0.6,
  };
  assert.equal(isPlateTriangle(inside, plate), true);
  assert.equal(isPlateTriangle(outside, plate), false);
});

test('clusterEyes 按面空间符号分左右眼并给出归一化锚点（UV 共用也能分开）', () => {
  const triangles: UvTriangle[] = [];
  for (let i = 0; i < 12; i += 1) {
    triangles.push(triangle(-0.0006, -0.0007 + i * 1e-6, -0.0004, -0.0007, -0.0005, -0.0006));
    triangles.push(triangle(0.0004, -0.0007 + i * 1e-6, 0.0006, -0.0007, 0.0005, -0.0006));
  }
  const eyes = clusterEyes(triangles);
  assert.equal(eyes.length, 2);
  const left = eyes.find((eye) => eye.x < 0);
  const right = eyes.find((eye) => eye.x > 0);
  assert.ok(left && right);
  assertClose(left!.x, -0.0005, 1e-9);
  assertClose(right!.x, 0.0005, 1e-9);
  assert.ok(left!.halfWidth > 0 && left!.halfHeight > 0);
  assert.equal(left!.triangles, 12);
});

test('clusterEyes 三角形太少时判为"未标定"，不硬画', () => {
  assert.equal(clusterEyes([triangle(0.1, 0.1, 0.2, 0.2, 0.3, 0.3)]).length, 0);
});

test('颊部锚点：在眼的外侧、下方，且半径由眼宽派生', () => {
  const cheeks = deriveCheekAnchors([
    { x: -0.0005, y: -0.0007, halfWidth: 0.0002, halfHeight: 0.00007, triangles: 40 },
    { x: 0.0005, y: -0.0007, halfWidth: 0.0002, halfHeight: 0.00007, triangles: 40 },
  ]);
  assert.equal(cheeks.length, 2);
  for (const cheek of cheeks) {
    const eyeX = cheek.x < 0 ? -0.0005 : 0.0005;
    assert.ok(Math.abs(cheek.x) > Math.abs(eyeX), '颊部应比眼更靠外');
    assert.ok(cheek.y < -0.0007, '颊部应在眼的下方');
    assertClose(cheek.rx, 0.0002 * 0.55, 1e-12);
    assert.ok(cheek.y > -0.0007 - 0.00007 * 1.01, '颊部不得掉到眼睛包围盒之外');
  }
});

test('trianglesBounds 对空集合返回 null', () => {
  assert.equal(trianglesBounds([]), null);
  const bounds = trianglesBounds([triangle(0, 0, 1, 0, 0, 1)]);
  assert.ok(bounds);
  assertClose(bounds!.minX, 0);
  assertClose(bounds!.maxY, 1);
});

// ---------------------------------------------------------------------------
// 8. 面空间栅格化（"在脸上贴"的核心，本轮保留）
// ---------------------------------------------------------------------------

test('buildSurface 把三角形 UV 栅格化成像素表，局部坐标由顶点面空间插值', () => {
  const tri: UvTriangle = {
    ax: 0, ay: 0, au: 0, av: 0,
    bx: 1, by: 0, bu: 1, bv: 0,
    cx: 0, cy: 1, cu: 0, cv: 1,
  };
  const surface = buildSurface(
    {
      triangles: [tri],
      toPixel: (u, v) => [u * 8, v * 8],
      toLocal: (u, v) => [(u - 0.5) / 0.5, (v - 0.5) / 0.5],
      bounds: { x: 0, y: 0, width: 8, height: 8 },
    },
    8,
    8,
  );
  assert.ok(surface, '应生成表面');
  assert.ok(surface!.count > 20, `像素数应覆盖三角形内部，实际 ${surface!.count}`);
  assert.equal(surface!.rect.x, 0);
  assert.equal(surface!.rect.width, 8);
  for (let i = 0; i < surface!.count; i += 1) {
    assert.ok(surface!.lx[i]! >= -1.02 && surface!.lx[i]! <= 1.02, `lx=${surface!.lx[i]}`);
    assert.ok(surface!.ly[i]! >= -1.02 && surface!.ly[i]! <= 1.02, `ly=${surface!.ly[i]}`);
  }
});

test('buildSurface 的 accept 过滤会丢掉区域外的像素', () => {
  const tri: UvTriangle = {
    ax: 0, ay: 0, au: 0, av: 0,
    bx: 1, by: 0, bu: 1, bv: 0,
    cx: 0, cy: 1, cu: 0, cv: 1,
  };
  const all = buildSurface(
    { triangles: [tri], toPixel: (u, v) => [u * 16, v * 16], toLocal: (u, v) => [u, v] },
    16,
    16,
  );
  const filtered = buildSurface(
    {
      triangles: [tri],
      toPixel: (u, v) => [u * 16, v * 16],
      toLocal: (u, v) => [u, v],
      accept: (lx, ly) => ellipseValue(lx, ly, 0.5, 0.5) <= 1,
    },
    16,
    16,
  );
  assert.ok(all && filtered);
  assert.ok(filtered!.count < all!.count);
});

test('buildSurface 对退化三角形（面积为 0）返回 null', () => {
  const degenerate: UvTriangle = {
    ax: 0.5, ay: 0.5, au: 0.5, av: 0.5,
    bx: 0.5, by: 0.5, bu: 0.5, bv: 0.5,
    cx: 0.5, cy: 0.5, cu: 0.5, cv: 0.5,
  };
  const surface = buildSurface(
    { triangles: [degenerate], toPixel: (u, v) => [u * 8, v * 8], toLocal: (u, v) => [u, v] },
    8,
    8,
  );
  assert.equal(surface, null);
});

test('dedupeSurfaces 丢掉完全重合的表面（左右眼共用 UV 时避免翻倍绘制）', () => {
  const make = (x: number): Parameters<typeof dedupeSurfaces>[0][number] => ({
    rect: { x, y: 0, width: 4, height: 4 },
    count: 3,
    index: new Int32Array([0, 1, 2]),
    lx: new Float32Array([0, 0.5, 1]),
    ly: new Float32Array([0, 0.5, 1]),
  });
  assert.equal(dedupeSurfaces([make(0), make(0)]).length, 1);
  assert.equal(dedupeSurfaces([make(0), make(8)]).length, 2);
});

test('percentileRange 取 1%/99% 分位，不会把区间塌成一个点', () => {
  // 均匀分布的 1000 个样本（0..999）
  const count = 1000;
  const values = new Float32Array(count);
  const covered = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    values[i] = i;
    covered[i] = 1;
  }
  const range = percentileRange(values, covered);
  assert.ok(range, '应返回区间');
  const [low, high] = range!;
  assert.ok(low >= 0 && low <= 20, `low 应接近 1% 分位，实际 ${low}`);
  assert.ok(high >= 975 && high <= 999, `high 应接近 99% 分位，实际 ${high}`);
  assert.ok(high - low > 900, '区间不得塌缩');

  // 全部相同 → 原样返回（不除零）
  const flat = new Float32Array(10).fill(3);
  const flatCovered = new Uint8Array(10).fill(1);
  assert.deepEqual(percentileRange(flat, flatCovered), [3, 3]);

  // 没有覆盖像素 → null
  assert.equal(percentileRange(values, new Uint8Array(count)), null);
});

// ---------------------------------------------------------------------------
// 9. 其他小工具
// ---------------------------------------------------------------------------

test('ellipseValue 的基本性质', () => {
  assertClose(ellipseValue(0, 0, 1, 1), 0);
  assertClose(ellipseValue(1, 0, 1, 1), 1);
  assertClose(ellipseValue(0, 2, 1, 1), 4);
});
