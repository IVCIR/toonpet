/**
 * 贴图取色：从 RGBA 像素里挑**主色**（众数），不是平均色。
 *
 * 为什么单独抽出来：口型底板要刷成"脸的颜色"，而脸贴图里混着眉毛、鼻影、
 * 下颌阴影和发梢压边。整张取平均会被这些深色像素拽下去——CH0335 实测
 * 平均 `(204,190,186)`、真实肤色 `(249,241,236)`，差 18%，刷上去就是脸上
 * 一块暗斑。众数取的是"面积最大的那个均匀色块"，正好是肤色。
 *
 * 纯函数（只吃像素数组），因此可以在没有 DOM 的环境里单测。
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** 量化到 5bit/通道：既能把同一肤色的抖动归到一个桶，又不至于糊成一片。 */
const QUANTIZE_SHIFT = 3;

/** 最大桶占比低于这个值就认为"没有主色"（多色渐变贴图），退回中位数。 */
const DOMINANT_SHARE = 0.1;

/**
 * @param pixels RGBA 连续像素（长度必须是 4 的倍数）
 * @returns 主色；全透明或长度非法时返回 null
 */
export function pickDominantColor(pixels: ArrayLike<number>): Rgb | null {
  if (!pixels || pixels.length < 4) return null;

  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  let opaque = 0;

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if ((pixels[i + 3] ?? 0) < 128) continue;
    const r = pixels[i] ?? 0;
    const g = pixels[i + 1] ?? 0;
    const b = pixels[i + 2] ?? 0;
    const key =
      ((r >> QUANTIZE_SHIFT) << 10) | ((g >> QUANTIZE_SHIFT) << 5) | (b >> QUANTIZE_SHIFT);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
    } else {
      buckets.set(key, { count: 1, r, g, b });
    }
    opaque += 1;
  }

  if (opaque === 0) return null;

  let best: { count: number; r: number; g: number; b: number } | null = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) best = bucket;
  }
  if (best && best.count / opaque >= DOMINANT_SHARE) {
    return {
      r: Math.round(best.r / best.count),
      g: Math.round(best.g / best.count),
      b: Math.round(best.b / best.count),
    };
  }

  // 众数不显著：逐通道中位数（比均值抗阴影与描边）
  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if ((pixels[i + 3] ?? 0) < 128) continue;
    reds.push(pixels[i] ?? 0);
    greens.push(pixels[i + 1] ?? 0);
    blues.push(pixels[i + 2] ?? 0);
  }
  const middle = (values: number[]): number => {
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)] ?? 0;
  };
  return { r: middle(reds), g: middle(greens), b: middle(blues) };
}
