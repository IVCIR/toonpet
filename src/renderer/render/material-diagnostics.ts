/**
 * 材质/网格只读诊断（阶段 14 视觉问题：手部发白）。
 *
 * 这些函数**不属于**契约 §7.3：只在 `window.diagnostics`（同页脚本 / 自检）里调用，
 * 不跨进程暴露、不进入 `RenderState`、不影响生产路径。
 *
 * 为什么单独一个文件：诊断要读 three 的几何/蒙皮/贴图内部结构，而这些细节
 * 不应该长在 `render-module.ts` 里（它已经 2000 行）。这里只做"读事实"和
 * "临时换材质"，不持有状态；恢复由调用方负责。
 */
import * as THREE from 'three';
import { computeSkinShade, dominantBoneNames, matchesSkinBone } from './skin-shading';
import type { SkinShadingOptions } from './skin-shading';

export type { SkinShadingOptions } from './skin-shading';

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
      const basic = material as THREE.MeshBasicMaterial;
      const map = basic.map ?? null;
      const box = handUvBox(mesh, handVertices);
      output.push({
        mesh: mesh.name || '(unnamed)',
        parent: mesh.parent?.name || '(root)',
        meshType: (mesh as THREE.SkinnedMesh).isSkinnedMesh ? 'SkinnedMesh' : 'Mesh',
        visible: mesh.visible,
        triangles,
        materialName: material.name || '(unnamed)',
        materialType: material.type,
        color: `#${basic.color?.getHexString?.() ?? 'ffffff'}`,
        vertexColors: basic.vertexColors === true,
        hasColorAttribute: mesh.geometry.hasAttribute('color'),
        alphaTest: basic.alphaTest ?? 0,
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
  /** 原始逐分量值（白 = 1；生产路径已烘焙后 = 烘焙结果） */
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
    // 先还原为诊断前的值（生产路径下是已烘焙的肤色，未烘焙时是白）
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

/**
 * 把"手/小臂"顶点的 **COLOR_0** 当作烘焙光照写进去（仍保持无光照材质）。
 *
 * 诊断用：会把结果写进可恢复的快照；生产路径的同类实现是 `skin-shading.ts`
 * 的 `bakeSkinShading`（不可恢复，加载期只跑一次）。
 */
export function shadeSkinVertices(
  root: THREE.Object3D,
  options: SkinShadingOptions,
): { meshes: number; vertices: number; minShade: number; maxShade: number } {
  let meshes = 0;
  let vertices = 0;
  let minShade = Number.POSITIVE_INFINITY;
  let maxShade = Number.NEGATIVE_INFINITY;

  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const snapshot = ensureColorSnapshot(mesh);
    if (!snapshot) return;
    const names = dominantBoneNames(mesh) ?? [];
    const normals = mesh.geometry.getAttribute('normal');
    const attribute = snapshot.replacement;
    (attribute.array as Float32Array).set(snapshot.values);
    let touched = 0;
    for (let i = 0; i < names.length; i += 1) {
      const hand = matchesSkinBone(names[i]!, 'hand');
      const forearm = matchesSkinBone(names[i]!, 'forearm');
      if (!hand && !forearm) continue;
      const nx = normals ? normals.getX(i) : 0;
      const ny = normals ? normals.getY(i) : 1;
      const nz = normals ? normals.getZ(i) : 0;
      const shade = computeSkinShade(nx, ny, nz, options);
      attribute.setXYZ(
        i,
        options.tint[0] * shade,
        options.tint[1] * shade,
        options.tint[2] * shade,
      );
      if (shade < minShade) minShade = shade;
      if (shade > maxShade) maxShade = shade;
      touched += 1;
      vertices += 1;
    }
    if (touched > 0) {
      attribute.needsUpdate = true;
      meshes += 1;
    }
  });

  if (!Number.isFinite(minShade)) {
    minShade = 1;
    maxShade = 1;
  }
  return { meshes, vertices, minShade, maxShade };
}

function restoreColorSnapshots(root: THREE.Object3D): void {
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

export type DiagnosticShading = 'basic' | 'toon-body' | 'toon-all';

export interface ShadingResult {
  mode: DiagnosticShading;
  materials: Array<{ mesh: string; from: string; to: string }>;
  lights: { ambient: number; directional: number } | null;
}

const originalMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();

/**
 * 诊断用着色模式切换：
 * - `basic`（生产路径）：无光照 `MeshBasicMaterial`，与 `model-loader` 的转换一致；
 * - `toon-body`：只把 `CH0335_Body` 材质换成 `MeshToonMaterial` + 光照；
 * - `toon-all`：全部材质换 Toon（含脸/眼嘴/头发），验证"连嘴部底板一起吃光"是否自洽。
 */
export function setDiagnosticShading(
  scene: THREE.Scene,
  root: THREE.Object3D,
  mode: DiagnosticShading,
  lights: { ambient: THREE.AmbientLight; directional: THREE.DirectionalLight } | null,
): {
  result: ShadingResult;
  lights: { ambient: THREE.AmbientLight; directional: THREE.DirectionalLight } | null;
} {
  const converted: Array<{ mesh: string; from: string; to: string }> = [];

  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!originalMaterials.has(mesh)) {
      originalMaterials.set(mesh, Array.isArray(mesh.material) ? [...mesh.material] : mesh.material);
    }
    const source = originalMaterials.get(mesh)!;
    if (mode === 'basic') {
      mesh.material = Array.isArray(source) ? [...source] : source;
      return;
    }
    const build = (material: THREE.Material): THREE.Material => {
      const basic = material as THREE.MeshBasicMaterial;
      if (mode === 'toon-body' && !/^CH0335_Body$/i.test(material.name)) return material;
      const toon = new THREE.MeshToonMaterial({
        name: material.name,
        map: basic.map ?? null,
        color: basic.color?.clone() ?? new THREE.Color(0xffffff),
        vertexColors: basic.vertexColors === true,
        transparent: basic.transparent,
        alphaTest: basic.alphaTest ?? 0,
        side: material.side,
        depthWrite: basic.depthWrite,
        toneMapped: false,
      });
      return toon;
    };
    const next = Array.isArray(source) ? source.map(build) : build(source);
    mesh.material = next;
    const list = Array.isArray(next) ? next : [next];
    const sourceList = Array.isArray(source) ? source : [source];
    for (let i = 0; i < list.length; i += 1) {
      const material = list[i]!;
      if (material === sourceList[i]) continue;
      converted.push({
        mesh: mesh.name || '(unnamed)',
        from: sourceList[i]?.name ?? '',
        to: material.type,
      });
    }
  });

  let currentLights = lights;
  if (mode !== 'basic' && !currentLights) {
    const ambient = new THREE.AmbientLight(0xffffff, 0.62);
    ambient.name = 'diagnostic-ambient';
    const directional = new THREE.DirectionalLight(0xffffff, 0.72);
    directional.name = 'diagnostic-directional';
    directional.position.set(0.35, 0.8, 1);
    scene.add(ambient, directional);
    currentLights = { ambient, directional };
  }
  if (mode === 'basic' && currentLights) {
    scene.remove(currentLights.ambient, currentLights.directional);
    currentLights.ambient.dispose();
    currentLights.directional.dispose();
    currentLights = null;
  }

  return {
    result: {
      mode,
      materials: converted,
      lights: currentLights
        ? { ambient: currentLights.ambient.intensity, directional: currentLights.directional.intensity }
        : null,
    },
    lights: currentLights,
  };
}

export function resetDiagnosticMaterials(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const original = originalMaterials.get(mesh);
    if (original) mesh.material = Array.isArray(original) ? [...original] : original;
  });
  originalMaterials.clear();
  restoreColorSnapshots(root);
}
