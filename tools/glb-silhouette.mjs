/**
 * 一次性分析脚本（不进产品）：读出 GLB 的逐网格世界包围盒，按高度分带求"侧影行剖面"。
 *
 * 目的：给 ADR 0058 的视口安全边距与单摆摆角约束定标提供**实测**数据
 * （每根头发/身体的左右边缘在哪一行、离窗口边缘还有多少 px）。
 * 只解析 JSON + BIN 两个 chunk（不加载贴图、不做蒙皮），完整 three 在这里没必要。
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'CH0335.glb';
const buf = readFileSync(file);
const magic = buf.readUInt32LE(0);
if (magic !== 0x46546c67) throw new Error('not a glb');
const total = buf.readUInt32LE(8);
let offset = 12;
let json = null;
let bin = null;
while (offset < total) {
  const len = buf.readUInt32LE(offset);
  const type = buf.readUInt32LE(offset + 4);
  const data = buf.subarray(offset + 8, offset + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
  if (type === 0x004e4942) bin = data;
  offset += 8 + len + ((4 - (len % 4)) % 4);
}

const nodes = json.nodes ?? [];
const meshes = json.meshes ?? [];
const accessors = json.accessors ?? [];

// 4x4 矩阵（列主序，GLTF 约定）
function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}
function fromTRS(node) {
  if (node.matrix) return node.matrix.slice();
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
function apply(m, v) {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
  ];
}

const views = json.bufferViews ?? [];
/** 读 POSITION 的 float32 顶点（只支持 VEC3 / float，够本资产用） */
function readPositions(accessorIndex) {
  const accessor = accessors[accessorIndex];
  if (!accessor || accessor.componentType !== 5126 || accessor.type !== 'VEC3') return null;
  const view = views[accessor.bufferView];
  if (!view) return null;
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = view.byteStride && view.byteStride > 0 ? view.byteStride : 12;
  const out = [];
  for (let i = 0; i < accessor.count; i += 1) {
    const at = base + i * stride;
    out.push([bin.readFloatLE(at), bin.readFloatLE(at + 4), bin.readFloatLE(at + 8)]);
  }
  return out;
}

const boxes = [];
const points = [];
function walk(index, parent) {
  const node = nodes[index] ?? {};
  const world = multiply(parent, fromTRS(node));
  if (typeof node.mesh === 'number') {
    const mesh = meshes[node.mesh];
    for (const primitive of mesh.primitives ?? []) {
      const positions = readPositions(primitive.attributes?.POSITION ?? -1);
      if (!positions) continue;
      const name = `${mesh.name ?? `mesh${node.mesh}`}`;
      const stride = Math.max(1, Math.floor(positions.length / 20000));
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < positions.length; i += stride) {
        const p = apply(world, positions[i]);
        points.push({ name, x: p[0], y: p[1] });
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
      }
      boxes.push({ name, minX, maxX, minY, maxY });
    }
  }
  for (const child of node.children ?? []) walk(child, world);
}
for (const scene of json.scenes ?? []) for (const root of scene.nodes ?? []) walk(root, identity());

const isExcluded = (name) => /(halo|weapon|prop|brush|outline)/i.test(name);
const included = points.filter((p) => !isExcluded(p.name));
const frameMinY = Math.min(...included.map((p) => p.y));
const frameMaxY = Math.max(...included.map((p) => p.y));
const frameMinX = Math.min(...included.map((p) => p.x));
const frameMaxX = Math.max(...included.map((p) => p.x));
const h = frameMaxY - frameMinY;
console.log(`boxes=${boxes.length} points=${included.length}`);
console.log(`frame units: x=[${frameMinX.toFixed(4)}, ${frameMaxX.toFixed(4)}] y=[${frameMinY.toFixed(4)}, ${frameMaxY.toFixed(4)}] h=${h.toFixed(4)}`);

// 1.0x 定标：模型高 626.087px（=720/1.15），脚底 = y0
const px = h > 0 ? 626.087 / h : 1;
const bands = 16;
const rows = Array.from({ length: bands }, () => ({ minX: Infinity, maxX: -Infinity }));
for (const p of included) {
  const r = Math.max(0, Math.min(bands - 1, Math.floor(((p.y - frameMinY) / h) * bands)));
  rows[r].minX = Math.min(rows[r].minX, p.x);
  rows[r].maxX = Math.max(rows[r].maxX, p.x);
}
const cx = (frameMinX + frameMaxX) / 2;
console.log('\nband  y(px above feet, top..)  left(px)  right(px)  width');
for (let r = bands - 1; r >= 0; r -= 1) {
  const row = rows[r];
  if (!Number.isFinite(row.minX)) continue;
  const yTop = frameMinY + ((r + 1) / bands) * h;
  const left = (row.minX - cx) * px;
  const right = (row.maxX - cx) * px;
  console.log(
    `${String(r).padStart(2)}  y=${((yTop - frameMinY) * px).toFixed(0).padStart(4)}  ` +
      `${left.toFixed(0).padStart(6)}  ${right.toFixed(0).padStart(6)}  ${(right - left).toFixed(0).padStart(5)}`,
  );
}
console.log(`\nmodel px: width=${((frameMaxX - frameMinX) * px).toFixed(1)} height=${(h * px).toFixed(1)}`);
