/**
 * 只读资产审查：遍历 GLB 的材质 / 贴图 / 顶点色，回答三个问题。
 *
 *   1. 每张贴图叫什么、多大分辨率、通道怎么构成（是不是 RGBA8、Alpha 有没有真的在用）；
 *   2. 有没有官方 NPR 常见的 **Mask / Ramp 贴图**（控制阴影范围、多通道打包的遮罩）；
 *   3. `COLOR_0`（顶点色）是不是真的带数据（还是全 1 的占位）。
 *
 * 不联网、不引入依赖、不写任何资产文件；只读 GLB 字节并写一份 JSON 报告。
 * PNG 由本脚本自带解码（`zlib.inflateSync` + 5 种 filter），不需要 canvas / sharp。
 *
 * 用法：
 *   node tools/audit-glb-assets.mjs [pathToGlb] [--json <out>]
 * 默认写 `dist/diagnostics/asset-audit.json`。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

const args = process.argv.slice(2);
const jsonFlag = args.indexOf('--json');
const jsonOut =
  jsonFlag >= 0 && args[jsonFlag + 1]
    ? resolve(args[jsonFlag + 1])
    : resolve('dist/diagnostics/asset-audit.json');
const glbPath = resolve(args.find((a, i) => !a.startsWith('--') && i !== jsonFlag + 1) ?? 'CH0335.glb');

// ---------------------------------------------------------------- GLB 解析
const buf = readFileSync(glbPath);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB（magic 不匹配）');

let offset = 12;
let json = null;
let bin = null;
while (offset + 8 <= buf.length) {
  const length = buf.readUInt32LE(offset);
  const type = buf.readUInt32LE(offset + 4);
  const data = buf.subarray(offset + 8, offset + 8 + length);
  if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8').replace(/\0+$/, '').trim());
  if (type === 0x004e4942) bin = data;
  offset += 8 + length;
}
if (!json || !bin) throw new Error('GLB 缺少 JSON 或 BIN chunk');
const g = json;

// ---------------------------------------------------------------- PNG 解码
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CHANNELS_BY_COLOR_TYPE = {
  0: { channels: 1, label: 'Gray' },
  2: { channels: 3, label: 'RGB' },
  3: { channels: 1, label: 'Palette' },
  4: { channels: 2, label: 'Gray+Alpha' },
  6: { channels: 4, label: 'RGBA' },
};

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** 解码 8/16 位非隔行 PNG → { width, height, channels:4, data: Uint8Array(RGBA) } */
function decodePng(bytes) {
  if (!bytes.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是 PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let interlace = 0;
  let palette = null;
  const idat = [];
  while (pos + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(pos);
    const type = bytes.toString('ascii', pos + 4, pos + 8);
    const data = bytes.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }
  const meta = CHANNELS_BY_COLOR_TYPE[colorType];
  const header = {
    width,
    height,
    bitDepth,
    colorType,
    colorLabel: meta ? meta.label : `type${colorType}`,
    interlace,
    palette: palette !== null,
  };
  if (!meta) return { ...header, decoded: false, reason: `未知 colorType ${colorType}` };
  if (interlace !== 0) return { ...header, decoded: false, reason: '隔行扫描（未实现）' };
  if (bitDepth !== 8 && bitDepth !== 16) {
    return { ...header, decoded: false, reason: `bitDepth ${bitDepth}（只支持 8/16）` };
  }

  const raw = inflateSync(Buffer.concat(idat));
  const sampleBytes = bitDepth === 16 ? 2 : 1;
  const bpp = meta.channels * sampleBytes;
  const rowBytes = width * bpp;
  const pixels = new Uint8Array(width * height * 4);
  let previous = Buffer.alloc(rowBytes);
  let cursor = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const row = Buffer.from(raw.subarray(cursor, cursor + rowBytes));
    cursor += rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= bpp ? row[x - bpp] : 0;
      const up = previous[x];
      const upLeft = x >= bpp ? previous[x - bpp] : 0;
      let value = row[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`未知 PNG filter ${filter}`);
      row[x] = value & 0xff;
    }
    previous = row;

    const sample = (index) => {
      if (bitDepth === 8) return row[index];
      // 16 位：取高位字节（视觉等价，统计够用）
      return row[index * 2];
    };
    for (let x = 0; x < width; x += 1) {
      const base = x * bpp;
      const out = (y * width + x) * 4;
      if (colorType === 6) {
        pixels[out] = sample(base);
        pixels[out + 1] = sample(base + 1);
        pixels[out + 2] = sample(base + 2);
        pixels[out + 3] = sample(base + 3);
      } else if (colorType === 2) {
        pixels[out] = sample(base);
        pixels[out + 1] = sample(base + 1);
        pixels[out + 2] = sample(base + 2);
        pixels[out + 3] = 255;
      } else if (colorType === 0) {
        const v = sample(base);
        pixels[out] = v;
        pixels[out + 1] = v;
        pixels[out + 2] = v;
        pixels[out + 3] = 255;
      } else if (colorType === 4) {
        const v = sample(base);
        pixels[out] = v;
        pixels[out + 1] = v;
        pixels[out + 2] = v;
        pixels[out + 3] = sample(base + 1);
      } else if (colorType === 3) {
        const index = sample(base);
        pixels[out] = palette?.[index * 3] ?? 0;
        pixels[out + 1] = palette?.[index * 3 + 1] ?? 0;
        pixels[out + 2] = palette?.[index * 3 + 2] ?? 0;
        pixels[out + 3] = 255;
      }
    }
  }
  return { ...header, decoded: true, data: pixels };
}

// ---------------------------------------------------------------- 图像统计
function analyzeImage(image) {
  if (!image.decoded) return { ...image, stats: null };
  const { width, height, data } = image;
  const sums = [0, 0, 0, 0];
  const mins = [255, 255, 255, 255];
  const maxs = [0, 0, 0, 0];
  const distinct = [new Set(), new Set(), new Set(), new Set()];
  const colors = new Map();
  let grayscalePixels = 0;
  let transparentPixels = 0;
  let semiTransparentPixels = 0;
  const total = width * height;

  for (let i = 0; i < total; i += 1) {
    const o = i * 4;
    const r = data[o];
    const gg = data[o + 1];
    const b = data[o + 2];
    const a = data[o + 3];
    const channelValues = [r, gg, b, a];
    for (let c = 0; c < 4; c += 1) {
      const v = channelValues[c];
      sums[c] += v;
      if (v < mins[c]) mins[c] = v;
      if (v > maxs[c]) maxs[c] = v;
      if (distinct[c].size < 4096) distinct[c].add(v);
    }
    if (r === gg && gg === b) grayscalePixels += 1;
    if (a === 0) transparentPixels += 1;
    else if (a < 255) semiTransparentPixels += 1;
    const key = (r << 24) | (gg << 16) | (b << 8) | a;
    colors.set(key, (colors.get(key) ?? 0) + 1);
  }

  const top = [...colors.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([key, count]) => ({
      hex: `#${((key >>> 8) & 0xffffff).toString(16).padStart(6, '0')}`,
      alpha: key & 0xff,
      share: count / total,
    }));

  const channelStats = ['r', 'g', 'b', 'a'].map((name, c) => ({
    channel: name,
    min: mins[c],
    max: maxs[c],
    mean: Math.round((sums[c] / total) * 10) / 10,
    distinct: distinct[c].size,
    varies: maxs[c] !== mins[c],
  }));

  return {
    ...image,
    data: undefined,
    stats: {
      pixels: total,
      uniqueColors: colors.size,
      grayscaleShare: grayscalePixels / total,
      transparentPixels,
      semiTransparentPixels,
      alphaUsed: mins[3] < 255,
      channelStats,
      topColors: top,
    },
  };
}

/** 这张图看起来是 Mask / Ramp 吗？返回判定与理由（不猜"官方意图"，只报数据形态）。 */
function classifyMaskTexture(name, stats) {
  if (!stats) return { maskLike: false, reasons: ['无法解码'] };
  const reasons = [];
  const lower = name.toLowerCase();
  if (/mask|ramp|toon|shade|shadow|lut|sdf|matcap|spec|id_|_rma|orm/i.test(lower)) {
    reasons.push(`文件名疑似（${name}）`);
  }
  const rgbConstant = stats.channelStats.slice(0, 3).every((s) => !s.varies);
  if (rgbConstant) reasons.push('RGB 恒定（不是颜色贴图）');
  if (stats.grayscaleShare > 0.98 && stats.uniqueColors > 2 && stats.uniqueColors <= 64) {
    reasons.push(`灰阶阶梯（${stats.uniqueColors} 种灰）`);
  }
  if (!stats.grayscaleShare && stats.uniqueColors <= 16 && stats.pixels >= 64) {
    reasons.push(`非灰阶但只有 ${stats.uniqueColors} 种颜色（疑似多通道打包）`);
  }
  return { maskLike: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------- 访问器
const COMPONENT = {
  5120: { size: 1, read: 'readInt8', max: 127, normalizedDivisor: 127 },
  5121: { size: 1, read: 'readUInt8', max: 255, normalizedDivisor: 255 },
  5122: { size: 2, read: 'readInt16LE', max: 32767, normalizedDivisor: 32767 },
  5123: { size: 2, read: 'readUInt16LE', max: 65535, normalizedDivisor: 65535 },
  5125: { size: 4, read: 'readUInt32LE', max: 4294967295, normalizedDivisor: 1 },
  5126: { size: 4, read: 'readFloatLE', max: 1, normalizedDivisor: 1 },
};
const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(index) {
  const accessor = g.accessors?.[index];
  if (!accessor) return null;
  const view = g.bufferViews?.[accessor.bufferView];
  if (!view) return null;
  const component = COMPONENT[accessor.componentType];
  const components = TYPE_COMPONENTS[accessor.type];
  if (!component || !components) return null;
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = view.byteStride ?? component.size * components;
  const values = [];
  for (let i = 0; i < accessor.count; i += 1) {
    const row = [];
    for (let c = 0; c < components; c += 1) {
      const at = base + i * stride + c * component.size;
      let value = bin[component.read](at);
      if (accessor.normalized && component.normalizedDivisor > 1) {
        value = Math.max(value / component.normalizedDivisor, -1);
      }
      row.push(value);
    }
    values.push(row);
  }
  return { accessor, components, values, normalized: accessor.normalized ?? false, componentType: accessor.componentType };
}

// ---------------------------------------------------------------- 报告
const report = {
  at: new Date().toISOString(),
  file: basename(glbPath),
  bytes: buf.length,
  generator: g.asset?.generator ?? null,
  counts: {
    meshes: g.meshes?.length ?? 0,
    nodes: g.nodes?.length ?? 0,
    materials: g.materials?.length ?? 0,
    textures: g.textures?.length ?? 0,
    images: g.images?.length ?? 0,
    animations: g.animations?.length ?? 0,
    skins: g.skins?.length ?? 0,
  },
  extensionsUsed: g.extensionsUsed ?? [],
  images: [],
  materials: [],
  vertexColors: [],
  verdict: {},
};

const line = (s = '') => console.log(s);

line(`# 资产审查：${basename(glbPath)}  ${(buf.length / 1024 / 1024).toFixed(1)} MB  generator=${g.asset?.generator ?? '?'}`);
line(
  `# 网格 ${report.counts.meshes} / 材质 ${report.counts.materials} / 贴图 ${report.counts.textures} / 图片 ${report.counts.images} / 动画 ${report.counts.animations}`,
);
line(`# extensionsUsed=${JSON.stringify(report.extensionsUsed)}`);

// 贴图 → 用途反查（槽位）
const SLOT_FIELDS = [
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
  'occlusionTexture',
  'emissiveTexture',
  'clearcoatTexture',
  'clearcoatRoughnessTexture',
  'clearcoatNormalTexture',
  'transmissionTexture',
  'thicknessTexture',
  'sheenColorTexture',
  'specularTexture',
];
const textureUsage = new Map();
for (const material of g.materials ?? []) {
  const pbr = material.pbrMetallicRoughness ?? {};
  const slots = { ...pbr, ...material };
  for (const field of SLOT_FIELDS) {
    const entry = slots[field];
    if (!entry || entry.index === undefined) continue;
    if (!textureUsage.has(entry.index)) textureUsage.set(entry.index, []);
    textureUsage.get(entry.index).push(`${material.name ?? '?'}:${field}`);
  }
}

line('\n## 1) 贴图（名称 / 分辨率 / 通道构成）');
line('  #  name                     size      fmt      unique  gray%   alpha    用途');
const imageResults = [];
for (const [i, img] of (g.images ?? []).entries()) {
  const view = g.bufferViews[img.bufferView];
  const bytes = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  let decoded;
  try {
    decoded = decodePng(bytes);
  } catch (error) {
    decoded = { width: 0, height: 0, decoded: false, reason: String(error) };
  }
  const analyzed = analyzeImage(decoded);
  const usage = [];
  for (const [ti, t] of (g.textures ?? []).entries()) {
    if (t.source !== i) continue;
    usage.push(...(textureUsage.get(ti) ?? [`texture[${ti}]:未引用`]));
  }
  const entry = {
    index: i,
    name: img.name ?? `image[${i}]`,
    mimeType: img.mimeType ?? null,
    width: analyzed.width,
    height: analyzed.height,
    format: analyzed.decoded
      ? `${analyzed.colorLabel}${analyzed.bitDepth === 16 ? '16' : '8'}`
      : `undecoded(${analyzed.reason})`,
    bytes: view.byteLength,
    usage: [...new Set(usage)],
    stats: analyzed.stats,
    mask: analyzed.stats ? classifyMaskTexture(img.name ?? '', analyzed.stats) : null,
  };
  imageResults.push(entry);
  const st = analyzed.stats;
  line(
    `  [${i}] ${String(entry.name).padEnd(24)} ${`${entry.width}x${entry.height}`.padEnd(9)} ${entry.format.padEnd(8)} ` +
      `${String(st?.uniqueColors ?? '-').padEnd(7)} ${String(st ? Math.round(st.grayscaleShare * 100) : '-').padEnd(7)} ` +
      `${st ? `${st.alphaUsed ? '有' : '全不透明'}(${st.transparentPixels}/${st.semiTransparentPixels})` : '-'}  ${entry.usage.join(',')}`,
  );
}
report.images = imageResults.map(({ stats, ...rest }) => ({
  ...rest,
  stats: stats
    ? {
        uniqueColors: stats.uniqueColors,
        grayscaleShare: Number(stats.grayscaleShare.toFixed(4)),
        alphaUsed: stats.alphaUsed,
        transparentPixels: stats.transparentPixels,
        semiTransparentPixels: stats.semiTransparentPixels,
        channelStats: stats.channelStats,
        topColors: stats.topColors,
      }
    : null,
}));

line('\n## 2) 材质（贴图槽位 / 渲染参数）');
for (const [i, material] of (g.materials ?? []).entries()) {
  const pbr = material.pbrMetallicRoughness ?? {};
  const slots = SLOT_FIELDS.filter((field) => (field.startsWith('baseColor') || field.startsWith('metallic'))
    ? pbr[field]
    : material[field]);
  const slotText = slots
    .map((field) => {
      const entry = field.startsWith('baseColor') || field.startsWith('metallic') ? pbr[field] : material[field];
      return `${field}=${g.images?.[g.textures?.[entry.index]?.source]?.name ?? `#${entry.index}`}`;
    })
    .join(' ');
  report.materials.push({
    index: i,
    name: material.name ?? `material[${i}]`,
    baseColorFactor: pbr.baseColorFactor ?? [1, 1, 1, 1],
    metallic: pbr.metallicFactor ?? 1,
    roughness: pbr.roughnessFactor ?? 1,
    alphaMode: material.alphaMode ?? 'OPAQUE',
    doubleSided: material.doubleSided ?? false,
    unlit: material.extensions?.KHR_materials_unlit ?? null,
    textureSlots: slots,
    extras: material.extras ?? null,
  });
  line(
    `  [${i}] ${String(material.name).padEnd(22)} baseColor=${g.images?.[g.textures?.[pbr.baseColorTexture?.index]?.source]?.name ?? 'null'}` +
      ` metallic=${(pbr.metallicFactor ?? 1).toFixed(2)} rough=${(pbr.roughnessFactor ?? 1).toFixed(2)}` +
      ` alpha=${material.alphaMode ?? 'OPAQUE'} double=${material.doubleSided ?? false}` +
      ` slots=[${slots.join(',') || '仅 baseColor'}]` +
      ` shading=${material.extras?.fromFBX?.shadingModel ?? '-'}`,
  );
}

/** 找到使用该 mesh 的节点（取它的 skin），用于把顶点色按骨骼归类。 */
function skinForMesh(meshIndex) {
  const node = (g.nodes ?? []).find((n) => n.mesh === meshIndex && n.skin !== undefined);
  if (!node) return null;
  const skin = g.skins?.[node.skin];
  if (!skin) return null;
  return { skin, joints: (skin.joints ?? []).map((j) => g.nodes?.[j]?.name ?? `joint${j}`) };
}

function dominantJoints(primitive, skin) {
  const jointsAccessor = readAccessor(primitive.attributes?.JOINTS_0);
  const weightsAccessor = readAccessor(primitive.attributes?.WEIGHTS_0);
  if (!jointsAccessor || !weightsAccessor) return null;
  return jointsAccessor.values.map((joints, i) => {
    const weights = weightsAccessor.values[i] ?? [0, 0, 0, 0];
    let best = 0;
    let bestWeight = -1;
    for (let k = 0; k < 4; k += 1) {
      if (weights[k] > bestWeight) {
        bestWeight = weights[k];
        best = k;
      }
    }
    return skin.joints[joints[best]] ?? `joint${joints[best]}`;
  });
}

line('\n## 3) 顶点色 COLOR_0');
let anyVertexColorData = false;
for (const [mi, mesh] of (g.meshes ?? []).entries()) {
  const skin = skinForMesh(mi);
  for (const [pi, primitive] of mesh.primitives.entries()) {
    const colorIndex = primitive.attributes?.COLOR_0;
    const entry = {
      mesh: mesh.name ?? `mesh[${mi}]`,
      primitive: pi,
      material: g.materials?.[primitive.material]?.name ?? null,
      present: colorIndex !== undefined,
      attributes: Object.keys(primitive.attributes ?? {}),
    };
    if (colorIndex === undefined) {
      report.vertexColors.push(entry);
      line(`  ${entry.mesh}[${pi}] ${entry.material}: 无 COLOR_0`);
      continue;
    }
    const accessor = readAccessor(colorIndex);
    if (!accessor) {
      line(`  ${entry.mesh}[${pi}] COLOR_0 读取失败`);
      report.vertexColors.push({ ...entry, error: 'accessor 读取失败' });
      continue;
    }
    const { values, components } = accessor;
    const min = new Array(components).fill(Number.POSITIVE_INFINITY);
    const max = new Array(components).fill(Number.NEGATIVE_INFINITY);
    let nonWhite = 0;
    let nonOpaque = 0;
    const colors = new Set();
    const rgbColors = new Set();
    for (const row of values) {
      let isWhite = true;
      for (let c = 0; c < components; c += 1) {
        const v = row[c];
        if (v < min[c]) min[c] = v;
        if (v > max[c]) max[c] = v;
        if (c < 3 && Math.abs(v - 1) > 1e-4) isWhite = false;
      }
      if (components > 3 && Math.abs(row[3] - 1) > 1e-4) nonOpaque += 1;
      if (!isWhite) nonWhite += 1;
      colors.add(row.map((v) => Math.round(v * 1000) / 1000).join(','));
      rgbColors.add(row.slice(0, 3).map((v) => Math.round(v * 1000) / 1000).join(','));
    }
    const hasData = nonWhite > 0 || nonOpaque > 0;
    if (hasData) anyVertexColorData = true;
    // Alpha 直方图（顶点色 alpha 是这批资产里**唯一**真的在变的分量）
    const alphaHistogram = new Map();
    const jointsByAlpha = new Map();
    const dominant = skin ? dominantJoints(primitive, skin) : null;
    values.forEach((row, i) => {
      const alpha = components > 3 ? Math.round(row[3] * 1000) / 1000 : 1;
      alphaHistogram.set(alpha, (alphaHistogram.get(alpha) ?? 0) + 1);
      if (!dominant) return;
      const bucket = alpha < 0.75 ? 'alpha<0.75' : 'alpha≥0.75';
      if (!jointsByAlpha.has(bucket)) jointsByAlpha.set(bucket, new Map());
      const bone = dominant[i] ?? '?';
      const counter = jointsByAlpha.get(bucket);
      counter.set(bone, (counter.get(bone) ?? 0) + 1);
    });
    const topJoints = {};
    for (const [bucket, counter] of jointsByAlpha) {
      topJoints[bucket] = [...counter.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([bone, count]) => `${bone}:${count}`);
    }
    entry.vertexCount = values.length;
    entry.components = components;
    entry.min = min.map((v) => Math.round(v * 10000) / 10000);
    entry.max = max.map((v) => Math.round(v * 10000) / 10000);
    entry.nonWhiteVertices = nonWhite;
    entry.nonOpaqueVertices = nonOpaque;
    entry.uniqueColors = colors.size;
    entry.uniqueRgb = rgbColors.size;
    entry.hasData = hasData;
    entry.componentType = accessor.componentType;
    entry.normalized = accessor.normalized;
    entry.alphaHistogram = [...alphaHistogram.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([alpha, count]) => ({ alpha, count }));
    entry.jointsByAlpha = topJoints;
    report.vertexColors.push(entry);
    line(
      `  ${String(entry.mesh).padEnd(20)}[${pi}] ${String(entry.material).padEnd(18)} n=${String(values.length).padEnd(5)} ` +
        `range=${JSON.stringify(entry.min)}..${JSON.stringify(entry.max)} 非白=${nonWhite} 非不透明=${nonOpaque} ` +
        `唯一色=${colors.size} → ${hasData ? '有数据' : '全 1（占位）'}`,
    );
    const hist = entry.alphaHistogram
      .slice(0, 5)
      .map((h) => `${h.alpha}×${h.count}`)
      .join(' ');
    line(`      alpha 直方图：${hist}`);
    if (dominant) {
      for (const [bucket, list] of Object.entries(topJoints)) {
        line(`      ${bucket} 主导骨骼：${list.join(' ')}`);
      }
    }
  }
}

// UV 通道
const uvChannels = new Set();
for (const mesh of g.meshes ?? []) {
  for (const primitive of mesh.primitives) {
    for (const key of Object.keys(primitive.attributes ?? {})) {
      if (/^TEXCOORD_/.test(key)) uvChannels.add(key);
    }
  }
}
line(`\n## 4) UV 通道：${[...uvChannels].sort().join(', ') || '无'}（Mask 贴图通常需要第二套 UV）`);

// ---------------------------------------------------------------- 结论
const maskCandidates = report.images.filter((image) => image.mask?.maskLike);
const oldMaskTexturePattern = /mask|ramp|toon|shade|shadow/i;
const namedMaskTextures = report.images.filter((image) => oldMaskTexturePattern.test(image.name));
const vertexColorMeshes = report.vertexColors.filter((entry) => entry.hasData);

report.verdict = {
  textureCount: report.images.length,
  maskOrRampTextures: maskCandidates.map((image) => ({
    name: image.name,
    size: `${image.width}x${image.height}`,
    reasons: image.mask.reasons,
  })),
  namedLikeMask: namedMaskTextures.map((image) => image.name),
  /** 材质只用了 baseColor 槽位（没有任何 Mask / Ramp / 法线 / 自发光槽） */
  onlyBaseColorSlots: report.materials.every(
    (material) =>
      material.textureSlots.length === 0 ||
      (material.textureSlots.length === 1 && material.textureSlots[0] === 'baseColorTexture'),
  ),
  grayscaleTextures: report.images
    .filter((image) => image.stats && image.stats.grayscaleShare > 0.98)
    .map((image) => image.name),
  secondaryUvChannels: [...uvChannels].filter((key) => key !== 'TEXCOORD_0'),
  vertexColorHasData: anyVertexColorData,
  /** RGB 是否没有任何空间变化（真 = 顶点色不能当颜色/明暗乘子用） */
  vertexColorRgbAllWhite: report.vertexColors
    .filter((entry) => entry.present)
    .every((entry) => (entry.uniqueRgb ?? 1) <= 1),
  vertexColorMeshesWithData: vertexColorMeshes.map((entry) => ({
    mesh: entry.mesh,
    material: entry.material,
    nonWhiteVertices: entry.nonWhiteVertices,
    nonOpaqueVertices: entry.nonOpaqueVertices,
    uniqueColors: entry.uniqueColors,
    uniqueRgb: entry.uniqueRgb,
    alphaHistogram: entry.alphaHistogram,
  })),
};

line('\n## 结论');
line(
  `  Mask / Ramp 贴图：${maskCandidates.length === 0 ? '无' : maskCandidates.map((image) => image.name).join(', ')}`,
);
line(`  文件名像 Mask 的贴图：${namedMaskTextures.length === 0 ? '无' : namedMaskTextures.map((image) => image.name).join(', ')}`);
line(`  材质贴图槽位只有 baseColor：${report.verdict.onlyBaseColorSlots ? '是（没有第二张图可挂 Mask/Ramp）' : '否'}`);
line(`  第二套 UV：${report.verdict.secondaryUvChannels.join(', ') || '无'}`);
line(`  灰阶贴图（灰度占比 >98%）：${report.verdict.grayscaleTextures.join(', ') || '无'}`);
line(
  `  顶点色（COLOR_0）带数据：${anyVertexColorData ? `是（${vertexColorMeshes.length} 个 primitive）` : '否（全为 1，纯占位）'}`,
);
line(
  `  顶点色 RGB 是否有空间变化：${report.verdict.vertexColorRgbAllWhite ? '没有（恒为 1 或单一常量，不能当颜色/明暗乘子）' : '有'}`,
);

mkdirSync(dirname(jsonOut), { recursive: true });
writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
line(`\n报告：${jsonOut}`);
