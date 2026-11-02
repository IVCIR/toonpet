/**
 * 材质/网格只读诊断（阶段 14 视觉问题的取证工具，阶段 15 起只保留"读事实"部分）。
 *
 * 这些函数**不属于**契约 §7.3：只在 `window.diagnostics`（同页脚本 / 自检）里调用，
 * 不跨进程暴露、不进入 `RenderState`、不影响生产路径。
 *
 * 生产着色已由 `toon-shading.ts` 接管（ADR 0037）；这里只保留三类取证能力：
 *   - `inspectMeshMaterials()`：每块网格用的什么材质 / 贴图多大 / 手在哪儿；
 *   - `tintSkinVertices()`：把"手/小臂主导"的顶点染红（证明手在哪块网格上）；
 *   - `replaceMaterialByName()`：把某个材质整体换纯色（证明手与衣服共用材质）。
 */
import * as THREE from 'three';

export interface TextureFacts {
  present: boolean;
  name: string | null;
  width: number | null;
  height: number | null;
  colorSpace: string | null;
}

export interface MeshMaterialFacts {
  mesh: string;
  parent: string;
  meshType: string;
  visible: boolean;
  triangles: number;
  materialName: string;
  materialType: string;
  color: string;
  vertexColors: boolean;
  hasColorAttribute: boolean;
  alphaTest: number;
  side: string;
  map: TextureFacts;
  /** 由 L/R Hand 骨骼主导的顶点数（诊断"手在哪块网格上"） */
  handVertices: number;
  /** 由 L/R Forearm 骨骼主导的顶点数 */
  forearmVertices: number;
  /** 手部顶点在贴图上的 UV 包围盒（u0,v0,u1,v1）；无手部顶点为 null */
  handUv: [number, number, number, number] | null;
  /** 手部 UV 区域中心采到的贴图颜色（sRGB #rrggbb）；采不到为 null */
  handTextureColor: string | null;
}

function sideName(side: THREE.Side): string {
  if (side === THREE.DoubleSide) return 'DoubleSide';
  if (side === THREE.BackSide) return 'BackSide';
  return 'FrontSide';
}

function textureFacts(texture: THREE.Texture | null): TextureFacts {
  if (!texture) return { present: false, name: null, width: null, height: null, colorSpace: null };
  const image = texture.image as { width?: number; height?: number; name?: string } | undefined;
  return {
    present: true,
    name: image?.name ?? texture.name ?? null,
    width: typeof image?.width === 'number' ? image.width : null,
    height: typeof image?.height === 'number' ? image.height : null,
    colorSpace: texture.colorSpace ?? null,
  };
}

/** 手部 UV 中心采样贴图颜色（sRGB）。失败返回 null（不抛异常）。 */
function sampleTextureColor(
  texture: THREE.Texture | null,
  u: number,
  v: number,
): string | null {
  const image = texture?.image as (CanvasImageSource & { width?: number; height?: number }) | undefined;
  if (!image || !texture) return null;
  try {
    const width = image.width ?? 0;
    const height = image.height ?? 0;
    if (!width || !height) return null;
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    const x = Math.min(width - 1, Math.max(0, Math.floor((u % 1) * width)));
    // glTF 的 v 轴向上，canvas 的 y 轴向下
    const y = Math.min(height - 1, Math.max(0, Math.floor((1 - (v % 1)) * height)));
    context.drawImage(image, x, y, 1, 1, 0, 0, 1, 1);
    const data = context.getImageData(0, 0, 1, 1).data;
    return `#${[data[0], data[1], data[2]].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return null;
  }
}

function handUvBox(
  mesh: THREE.Mesh,
  handIndices: readonly number[],
): [number, number, number, number] | null {
  const uv = mesh.geometry.getAttribute('uv');
  if (!uv || handIndices.length === 0) return null;
  let u0 = Number.POSITIVE_INFINITY;
  let v0 = Number.POSITIVE_INFINITY;
  let u1 = Number.NEGATIVE_INFINITY;
  let v1 = Number.NEGATIVE_INFINITY;
  for (const i of handIndices) {
    const u = uv.getX(i);
    const v = uv.getY(i);
    if (u < u0) u0 = u;
    if (v < v0) v0 = v;
    if (u > u1) u1 = u;
    if (v > v1) v1 = v;
  }
  return [u0, v0, u1, v1];
}

/** 顶点主导骨名（按最大权重的 JOINTS_0 分量）。非蒙皮网格返回 null。 */
export function dominantBoneNames(mesh: THREE.Mesh): string[] | null {
  const skinned = mesh as THREE.SkinnedMesh;
  if (!skinned.isSkinnedMesh || !skinned.skeleton) return null;
  const geometry = mesh.geometry;
  const skinIndex = geometry.getAttribute('skinIndex');
  const skinWeight = geometry.getAttribute('skinWeight');
  if (!skinIndex || !skinWeight) return null;
  const bones = skinned.skeleton.bones;
  const names: string[] = [];
  for (let i = 0; i < skinIndex.count; i += 1) {
    let best = 0;
    let bestWeight = -1;
    for (let k = 0; k < 4; k += 1) {
      const weight = skinWeight.getComponent(i, k);
      if (weight > bestWeight) {
        bestWeight = weight;
        best = k;
      }
    }
    names.push(bones[skinIndex.getComponent(i, best)]?.name ?? '');
  }
  return names;
}

/** three 里的骨名形如 `Bip001_L_Hand`（GLTFLoader 清洗过空格）。 */
export function matchesSkinBone(name: string, kind: 'hand' | 'forearm'): boolean {
  if (!name) return false;
  return new RegExp(`(?:^|_)${kind}(?:_|$)`, 'i').test(name);
}

/**
 * 遍历场景里所有 Mesh / SkinnedMesh，输出"这块网格用的什么材质、贴图在不在、
 * 色彩空间是什么、手上多少顶点"。
 */
export function inspectMeshMaterials(root: THREE.Object3D): MeshMaterialFacts[] {
  const output: MeshMaterialFacts[] = [];
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const names = dominantBoneNames(mesh) ?? [];
    const handVertices =
      names.length === 0
        ? []
        : names.map((n, i) => (matchesSkinBone(n, 'hand') ? i : -1)).filter((i) => i >= 0);
    const forearmVertices =
      names.length === 0
        ? []
        : names.map((n, i) => (matchesSkinBone(n, 'forearm') ? i : -1)).filter((i) => i >= 0);
    const index = mesh.geometry.getIndex();
    const position = mesh.geometry.getAttribute('position');
    const triangles = Math.floor((index ? index.count : position?.count ?? 0) / 3);
    for (const material of materials) {
      if (!material) continue;
      // Toon 与 Basic 都有 map / color（`MeshToonMaterial` 继承自它需要的公共字段）
      const withMap = material as THREE.MeshBasicMaterial;
      const map = withMap.map ?? null;
      const box = handUvBox(mesh, handVertices);
      output.push({
        mesh: mesh.name || '(unnamed)',
        parent: mesh.parent?.name || '(root)',
        meshType: (mesh as THREE.SkinnedMesh).isSkinnedMesh ? 'SkinnedMesh' : 'Mesh',
        visible: mesh.visible,
        triangles,
        materialName: material.name || '(unnamed)',
        materialType: material.type,
        color: `#${withMap.color?.getHexString?.() ?? 'ffffff'}`,
        vertexColors: withMap.vertexColors === true,
        hasColorAttribute: mesh.geometry.hasAttribute('color'),
        alphaTest: withMap.alphaTest ?? 0,
        side: sideName(material.side),
        map: textureFacts(map),
        handVertices: handVertices.length,
        forearmVertices: forearmVertices.length,
        handUv: box,
        handTextureColor:
          box && map ? sampleTextureColor(map, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2) : null,
      });
    }
  });
  return output;
}

interface VertexColorSnapshot {
  /** 原始 COLOR_0（可能是 InterleavedBufferAttribute：glTF-Transform 会交错存放） */
  original: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  /** 原始逐分量值（诊断前的值） */
  values: Float32Array;
  itemSize: number;
  /** 诊断期间替换成的独立 BufferAttribute（可安全写） */
  replacement: THREE.BufferAttribute;
}

const colorSnapshots = new Map<string, VertexColorSnapshot>();

/**
 * 确保 COLOR_0 是一个可写的 `BufferAttribute`。
 *
 * 为什么不能直接写：glTF 的 `COLOR_0` 可能是 **InterleavedBufferAttribute**
 * （`bufferView.byteStride` 存在时 GLTFLoader 会交错存放），它没有独立的 `array`，
 * `needsUpdate` 也不在属性本身上。第一版直接 `instanceof BufferAttribute` 判断，
 * 结果 6 块网格全被跳过（诊断输出 `meshes=0`），手一个顶点都没染上。
 */
function ensureColorSnapshot(mesh: THREE.Mesh): VertexColorSnapshot | null {
  const existing = colorSnapshots.get(mesh.uuid);
  if (existing) return existing;
  const current = mesh.geometry.getAttribute('color');
  if (!current) return null;
  const itemSize = Math.max(3, current.itemSize);
  const count = current.count;
  const values = new Float32Array(count * itemSize);
  for (let i = 0; i < count; i += 1) {
    for (let k = 0; k < itemSize; k += 1) {
      values[i * itemSize + k] = current.getComponent(i, Math.min(k, current.itemSize - 1));
    }
  }
  const replacement = new THREE.BufferAttribute(new Float32Array(values), itemSize);
  mesh.geometry.setAttribute('color', replacement);
  const snapshot: VertexColorSnapshot = { original: current, values, itemSize, replacement };
  colorSnapshots.set(mesh.uuid, snapshot);
  return snapshot;
}

/**
 * 临时把"手/小臂主导"的顶点染成指定颜色（保留贴图，只改顶点色）。
 *
 * 用途：证明"红色的那块就是手"——比把整块 Body 网格换成纯红更能说明问题，
 * 因为 Body 网格同时包含衣服、腿、脖子（它们不该变红）。
 */
export function tintSkinVertices(
  root: THREE.Object3D,
  scope: 'none' | 'hand' | 'both',
  color: [number, number, number] = [1, 0, 0],
): { meshes: number; handVertices: number; forearmVertices: number } {
  let meshes = 0;
  let handVertices = 0;
  let forearmVertices = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const snapshot = ensureColorSnapshot(mesh);
    if (!snapshot) return;
    const names = dominantBoneNames(mesh) ?? [];
    const attribute = snapshot.replacement;
    // 先还原为诊断前的值
    (attribute.array as Float32Array).set(snapshot.values);
    let touched = 0;
    for (let i = 0; i < names.length; i += 1) {
      const hand = matchesSkinBone(names[i]!, 'hand');
      const forearm = matchesSkinBone(names[i]!, 'forearm');
      if (!hand && !forearm) continue;
      if (scope === 'hand' && !hand) continue;
      if (scope === 'none') continue;
      attribute.setXYZ(i, color[0], color[1], color[2]);
      if (hand) handVertices += 1;
      else forearmVertices += 1;
      touched += 1;
    }
    if (touched > 0 || scope === 'none') {
      attribute.needsUpdate = true;
      meshes += 1;
    }
  });
  return { meshes, handVertices, forearmVertices };
}

/** 还原诊断期间换掉的顶点色（回到模型原始 COLOR_0）。 */
export function restoreVertexColorDiagnostics(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const snapshot = colorSnapshots.get(mesh.uuid);
    if (!snapshot) return;
    mesh.geometry.setAttribute('color', snapshot.original);
    snapshot.original.needsUpdate = true;
  });
  colorSnapshots.clear();
}

/** 临时把某个材质名对应的网格换成纯色 Basic 材质（诊断"这是不是同一块网格"）。 */
export function replaceMaterialByName(
  root: THREE.Object3D,
  materialName: string,
  color: number,
): { meshes: string[]; restore(): void } {
  const changed: Array<{ mesh: THREE.Mesh; previous: THREE.Material | THREE.Material[] }> = [];
  const replacement = new THREE.MeshBasicMaterial({
    color,
    name: `diagnostic:${materialName}`,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (!materials.some((m) => m?.name === materialName)) return;
    changed.push({ mesh, previous: mesh.material });
    mesh.material = replacement;
  });
  return {
    meshes: changed.map((entry) => entry.mesh.name || '(unnamed)'),
    restore: () => {
      for (const entry of changed) entry.mesh.material = entry.previous;
      replacement.dispose();
    },
  };
}
