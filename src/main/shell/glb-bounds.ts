/**
 * GLB 包围盒解析（主进程侧，纯函数，ADR 0009 D2/D3）。
 *
 * 只解析 GLB 的 JSON chunk：不依赖 three、不依赖 DOM、不执行模型内容。
 * 用途：窗口必须在渲染进程加载模型**之前**就按包围盒创建（§3.2），
 * 所以这里自己组合节点 TRS 求世界 AABB；蒙皮形变不参与（与 three 的
 * `Box3.setFromObject` 同一近似，差异由自检截图兜底）。
 */
import { readFileSync } from 'node:fs';
import { matchesFrameExclude, mergeBounds, type Bounds3 } from '../../shared/model-frame';

export interface GlbMeshBounds {
  name: string;
  bounds: Bounds3;
}

export interface GlbBoundsResult {
  ok: boolean;
  /** 全部网格的并集（含武器/道具） */
  sceneBounds: Bounds3 | null;
  /** 取景包围盒（排除 PET_FRAME_EXCLUDE 命中的网格） */
  frameBounds: Bounds3 | null;
  meshes: GlbMeshBounds[];
  excludedMeshes: string[];
  hasMorphTargets: boolean;
  nodeCount: number;
  extensionsRequired: string[];
  error?: string;
}

interface GltfNode {
  name?: string;
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
}

interface GltfDocument {
  scene?: number;
  scenes?: Array<{ nodes?: number[] }>;
  nodes?: GltfNode[];
  meshes?: Array<{
    name?: string;
    primitives?: Array<{
      attributes?: Record<string, number>;
      targets?: unknown[];
    }>;
  }>;
  accessors?: Array<{ min?: number[]; max?: number[] }>;
  extensionsRequired?: string[];
}

export interface ParseGlbOptions {
  /** 取景排除正则；默认不排除 */
  excludePattern?: string;
}

const IDENTITY: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += (a[k * 4 + row] ?? 0) * (b[column * 4 + k] ?? 0);
      }
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/** glTF 节点 TRS（列主序）→ 4×4 矩阵。 */
function nodeMatrix(node: GltfNode): number[] {
  if (node.matrix && node.matrix.length === 16) return node.matrix.slice();
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];

  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;

  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

function transformCorner(m: readonly number[], x: number, y: number, z: number): [number, number, number] {
  return [
    (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0),
    (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0),
    (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0),
  ];
}

function boundsOfMesh(
  doc: GltfDocument,
  meshIndex: number,
  world: readonly number[],
): Bounds3 | null {
  const mesh = doc.meshes?.[meshIndex];
  if (!mesh?.primitives) return null;

  const bounds: Bounds3 = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  };
  let any = false;

  for (const primitive of mesh.primitives) {
    const accessorIndex = primitive.attributes?.['POSITION'];
    if (accessorIndex === undefined) continue;
    const accessor = doc.accessors?.[accessorIndex];
    if (!accessor?.min || !accessor?.max || accessor.min.length < 3 || accessor.max.length < 3) continue;

    for (const x of [accessor.min[0]!, accessor.max[0]!]) {
      for (const y of [accessor.min[1]!, accessor.max[1]!]) {
        for (const z of [accessor.min[2]!, accessor.max[2]!]) {
          const [wx, wy, wz] = transformCorner(world, x, y, z);
          bounds.minX = Math.min(bounds.minX, wx);
          bounds.minY = Math.min(bounds.minY, wy);
          bounds.minZ = Math.min(bounds.minZ, wz);
          bounds.maxX = Math.max(bounds.maxX, wx);
          bounds.maxY = Math.max(bounds.maxY, wy);
          bounds.maxZ = Math.max(bounds.maxZ, wz);
          any = true;
        }
      }
    }
  }

  return any ? bounds : null;
}

function readJsonChunk(buffer: Buffer): { doc?: GltfDocument; error?: string } {
  if (buffer.length < 20) return { error: 'GLB 太短' };
  if (buffer.toString('ascii', 0, 4) !== 'glTF') return { error: 'magic 不是 glTF' };
  if (buffer.readUInt32LE(4) !== 2) return { error: `不支持的 glTF 版本 ${buffer.readUInt32LE(4)}` };

  const declaredLength = Math.min(buffer.readUInt32LE(8), buffer.length);
  let offset = 12;
  while (offset + 8 <= declaredLength) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + chunkLength;
    if (end > buffer.length) return { error: 'chunk 越界' };
    if (chunkType === 'JSON') {
      try {
        return { doc: JSON.parse(buffer.toString('utf8', start, end)) as GltfDocument };
      } catch (error) {
        return { error: `JSON chunk 解析失败：${String(error)}` };
      }
    }
    offset = end;
  }
  return { error: '缺少 JSON chunk' };
}

export function parseGlbBounds(buffer: Buffer, options: ParseGlbOptions = {}): GlbBoundsResult {
  const empty: GlbBoundsResult = {
    ok: false,
    sceneBounds: null,
    frameBounds: null,
    meshes: [],
    excludedMeshes: [],
    hasMorphTargets: false,
    nodeCount: 0,
    extensionsRequired: [],
  };

  const { doc, error } = readJsonChunk(buffer);
  if (!doc) return { ...empty, error: error ?? '未知解析错误' };

  const nodes = doc.nodes ?? [];
  const meshes: GlbMeshBounds[] = [];
  const excludedMeshes: string[] = [];
  const excludePattern = options.excludePattern ?? '';

  const scene = doc.scenes?.[doc.scene ?? 0];
  const roots = scene?.nodes ?? [];
  const stack: Array<{ index: number; parent: readonly number[] }> = roots.map((index) => ({
    index,
    parent: IDENTITY,
  }));

  while (stack.length > 0) {
    const { index, parent } = stack.pop()!;
    const node = nodes[index];
    if (!node) continue;
    const world = multiply(parent, nodeMatrix(node));

    if (node.mesh !== undefined) {
      const bounds = boundsOfMesh(doc, node.mesh, world);
      if (bounds) {
        const name = node.name ?? doc.meshes?.[node.mesh]?.name ?? `mesh#${node.mesh}`;
        meshes.push({ name, bounds });
        if (matchesFrameExclude(name, excludePattern)) excludedMeshes.push(name);
      }
    }

    for (const child of node.children ?? []) {
      stack.push({ index: child, parent: world });
    }
  }

  const sceneBounds = mergeBounds(meshes.map((item) => item.bounds));
  if (!sceneBounds) return { ...empty, nodeCount: nodes.length, error: '没有任何可用的网格包围盒' };

  const included = meshes.filter((item) => !excludedMeshes.includes(item.name));
  const frameBounds = mergeBounds(included.map((item) => item.bounds)) ?? sceneBounds;

  let hasMorphTargets = false;
  for (const mesh of doc.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      if ((primitive.targets?.length ?? 0) > 0) hasMorphTargets = true;
    }
  }

  return {
    ok: true,
    sceneBounds,
    frameBounds,
    meshes,
    excludedMeshes,
    hasMorphTargets,
    nodeCount: nodes.length,
    extensionsRequired: doc.extensionsRequired ?? [],
  };
}

/** 读文件 + 解析；任何失败都只返回 `ok=false`，绝不抛给启动流程。 */
export function readGlbBounds(path: string, options: ParseGlbOptions = {}): GlbBoundsResult {
  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch (error) {
    return {
      ok: false,
      sceneBounds: null,
      frameBounds: null,
      meshes: [],
      excludedMeshes: [],
      hasMorphTargets: false,
      nodeCount: 0,
      extensionsRequired: [],
      error: `读取失败：${String(error)}`,
    };
  }
  return parseGlbBounds(buffer, options);
}
