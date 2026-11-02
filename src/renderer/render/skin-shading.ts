/**
 * 手/小臂肤色烘焙（ADR 0036，阶段 14 真机问题修复）。
 *
 * 背景（实测）：`CH0335_Body.png` 是**平涂色块**贴图，手部 150 个顶点的 UV
 * 全部落在 `u 0.2830–0.2854 × v 0.9558–0.9577` 这一小块上（512² 下约 1.2 texel），
 * 采样值恒为 `#f1edec`；而渲染管线是**无光照** `MeshBasicMaterial`（模型加载时
 * 统一转换，见 `model-loader.ts`）。两者叠加的结果就是"手 = 一块纯白发光板"：
 * 没有贴图细节、没有明暗、没有肤色层次。
 *
 * 修复不换材质、不加灯（保持零运行时成本与既有美术方向）：
 * 把**法线方向的明暗**乘一个**暖肤色**写进 `COLOR_0`（顶点色），材质本来就
 * `vertexColors: true`，因此不需要任何新管线。只在手/小臂顶点上写，其它顶点
 * 保持 1（模型原始值），衣服/脸/头发完全不受影响。
 *
 * 这不是"猜测性染色"：明暗因子来自每个顶点自己的法线，与固定光向
 * `(-0.35, 0.65, 0.68)`（左上前方，与桌面宠物的默认观感一致）点乘。
 */
import * as THREE from 'three';

export interface SkinShadingOptions {
  /** 背光面保留的亮度（0–1） */
  ambient: number;
  /** 朝向光时额外加的亮度（0–1） */
  diffuse: number;
  /** 模型空间的"指向光"单位向量；+Z 是角色正面 */
  light: [number, number, number];
  /** 肤色乘子（让 #f1edec 偏暖，而不是变成灰色） */
  tint: [number, number, number];
}

/**
 * 默认参数（实测：手部像素均值从 `#f6efeb` 的 96.6% 近白，降到 `#e1d3ca`
 * 的 0.2% 近白；可视为"有肤色、有明暗"，且不改变脸/衣服的亮度）。
 *
 * ============================================================================
 * 参数怎么调（换模型 / 换皮肤时先读这段）
 * ============================================================================
 *
 * 先跑一次诊断，拿到"手部 UV 包围盒、UV 区域颜色、顶点数、A/B 近白占比"：
 *
 *   $env:PET_SELFTEST=1; $env:PET_HAND_DIAG=1; node scripts/start.mjs
 *   → dist/diagnostics/hand-diagnosis.json
 *   → dist/selftest/hand-00-before-bake.png / hand-00-baseline.png
 *
 * 四个参数的含义（都是"乘在贴图颜色上"的线性系数）：
 *
 *   ambient  背光面保留的亮度。越大越亮、越平；越小越暗、越有体积。
 *            手部顶点只有 150 个，ambient 低于 ~0.65 容易在指缝处出现硬边。
 *   diffuse  朝向光时额外加的亮度。越大明暗对比越强；过大会像"塑料假手"。
 *            经验范围 0.15–0.30；顶点越少越应该取小值（避免色带）。
 *   light    模型空间的"指向光"单位向量（内部会归一化）。
 *            坐标约定：+Y 向上、+Z 朝向镜头（角色正面）、+X 是画面右侧。
 *            当前 (-0.35, 0.65, 0.68) = 左上前方；左右手明暗反了就把 X 取反。
 *   tint     肤色乘子。三个分量都 ≤1；R 分量保持 1、G/B 往下压 = 偏暖的肤色。
 *            当前 (1, 0.90, 0.85) 把 #f1edec 拉成 #e1d3ca 左右。
 *
 * 换模型时的决策表：
 *
 *   | 新模型的情况 | 怎么改 |
 *   |---|---|
 *   | 手部贴图本身就有明暗（UV 面积大、颜色有梯度） | `diffuse=0`、`tint=(1,1,1)`（等价于完全不动），或直接不调用 `bakeSkinShading()` |
 *   | 手仍然偏白 / 像白板 | `tint` 再压暖一点，如 `(1, 0.86, 0.80)`；`ambient` 降到 0.74 |
 *   | 手太暗、发灰、像戴了灰手套 | `ambient` 提到 0.84、`diffuse` 降到 0.14，`tint` 提亮到 `(1, 0.94, 0.90)` |
 *   | 手指/手背出现硬边或色带 | `diffuse` 降到 0.12–0.16、`ambient` 提到 0.82–0.86 |
 *   | 左右手明暗反了（光源看起来在另一侧） | `light[0]` 取反，如 `(0.35, 0.65, 0.68)` |
 *   | 手心/手背的明暗关系不对 | 调整 `light[2]`（正面分量），或把 `light[1]` 降低 |
 *   | 手和脸的色差太大 | 先把 `tint` 调到 `(1, 0.95, 0.91)` 缩小差距；不要改脸/衣服材质 |
 *
 * 其他约束：
 *   - `ambient + diffuse` 建议 ≤ 1；超过 1 会被 `clamp` 到 1（高光死白）。
 *   - 这个函数只写 `Bip001 L/R Hand` + `L/R Forearm` 主导的顶点；新模型如果骨骼
 *     命名不同（没有 Hand/Forearm），会匹配到 0 个顶点并在诊断里显示 `vertices=0`。
 *   - 想临时关闭做 A/B：`window.diagnostics.setSkinBake(false/true)`（只影响当前进程，
 *     不写配置）；持久关闭就把 `render-module.ts` 里的 `bakeSkinShading()` 调用去掉，
 *     或传 `{ ...DEFAULT_SKIN_SHADING, diffuse: 0, tint: [1, 1, 1] }`。
 *   - 换模型后**必须**重新跑 `PET_HAND_DIAG=1` 并人眼复核截图；本文件的默认值只对
 *     `CH0335.glb`（平涂身体贴图）标定过。
 */
export const DEFAULT_SKIN_SHADING: SkinShadingOptions = {
  ambient: 0.78,
  diffuse: 0.22,
  light: [-0.35, 0.65, 0.68],
  tint: [1, 0.9, 0.85],
};

export interface SkinShadingStats {
  /** 实际写入了颜色的网格数 */
  meshes: number;
  /** 手 + 小臂顶点总数 */
  vertices: number;
  minShade: number;
  maxShade: number;
  /** 写入颜色的均值（0–1，线性乘子口径） */
  meanColor: [number, number, number];
}

function normalize(v: [number, number, number]): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** 单顶点的明暗乘子（与 `bakeSkinShading` 同一公式；诊断也用它，避免两套实现漂移）。 */
export function computeSkinShade(
  nx: number,
  ny: number,
  nz: number,
  options: SkinShadingOptions,
): number {
  if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) {
    return Math.min(1, Math.max(0, options.ambient));
  }
  const [lx, ly, lz] = normalize(options.light);
  const ndl = Math.max(0, nx * lx + ny * ly + nz * lz);
  return Math.min(1, Math.max(0, options.ambient + options.diffuse * ndl));
}

/** 顶点主导骨名（与 `inspectMeshMaterials` 共用同一判据）。 */
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
 * 把 COLOR_0 变成**可写**的独立 `BufferAttribute`。
 *
 * glTF 的 COLOR_0 可能是 `InterleavedBufferAttribute`（glTF-Transform 把属性
 * 交错存放时会这样），它没有独立 `array`、`needsUpdate` 也不在属性上。
 */
function ensureWritableColors(mesh: THREE.Mesh): THREE.BufferAttribute | null {
  const geometry = mesh.geometry;
  const current = geometry.getAttribute('color');
  const count = geometry.getAttribute('position')?.count ?? 0;
  if (count === 0) return null;

  if (!current) {
    const attribute = new THREE.Float32BufferAttribute(new Float32Array(count * 3).fill(1), 3);
    geometry.setAttribute('color', attribute);
    return attribute;
  }
  if (
    current instanceof THREE.BufferAttribute &&
    current.itemSize >= 3 &&
    current.array instanceof Float32Array
  ) {
    return current;
  }
  // Interleaved / 非 Float32（Uint8 等归一化存储）/ itemSize < 3：
  // 统一复制成独立 Float32 attribute，否则 setXYZ(0.83) 写进 Uint8 会被截断成 0（手变黑）。
  const itemSize = Math.max(3, current.itemSize);
  const array = new Float32Array(count * itemSize);
  const raw = current instanceof THREE.BufferAttribute ? current.array : current.data.array;
  // three 的 `getComponent()` 对 normalized 属性已经做了反归一化；只有
  // "非 normalized 的整数存储"才需要手工除以满量程。
  const scale = current.normalized ? 1 : normalizedMax(raw);
  for (let i = 0; i < count; i += 1) {
    for (let k = 0; k < itemSize; k += 1) {
      const component = Math.min(k, current.itemSize - 1);
      array[i * itemSize + k] = current.getComponent(i, component) / scale;
    }
  }
  const attribute = new THREE.BufferAttribute(array, itemSize);
  geometry.setAttribute('color', attribute);
  return attribute;
}

/** 归一化整数顶点色的满量程（用于换算回 0–1）。 */
function normalizedMax(array: ArrayLike<number>): number {
  if (array instanceof Uint8Array || array instanceof Int8Array) return 255;
  if (array instanceof Uint16Array || array instanceof Int16Array) return 65535;
  return 1;
}

/**
 * 把手/小臂顶点的法线明暗 + 暖肤色写进 COLOR_0，并返回统计。
 *
 * 幂等：重复调用只会用相同参数重写同一批顶点（不会逐次变暗）。
 * 第一次调用会保存"烘焙前"的顶点色，供 `restoreSkinShading()` 做 A/B 对照。
 */
export function bakeSkinShading(
  root: THREE.Object3D,
  options: SkinShadingOptions = DEFAULT_SKIN_SHADING,
): SkinShadingStats {
  const [lx, ly, lz] = normalize(options.light);
  let meshes = 0;
  let vertices = 0;
  let minShade = Number.POSITIVE_INFINITY;
  let maxShade = Number.NEGATIVE_INFINITY;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const names = dominantBoneNames(mesh);
    if (!names) return;
    const indices: number[] = [];
    for (let i = 0; i < names.length; i += 1) {
      if (matchesSkinBone(names[i]!, 'hand') || matchesSkinBone(names[i]!, 'forearm')) {
        indices.push(i);
      }
    }
    if (indices.length === 0) return;

    const attribute = ensureWritableColors(mesh);
    if (!attribute) return;
    if (!preBakeSnapshots.has(mesh.uuid)) {
      const values = new Float32Array(attribute.count * attribute.itemSize);
      for (let i = 0; i < attribute.count; i += 1) {
        for (let k = 0; k < attribute.itemSize; k += 1) {
          values[i * attribute.itemSize + k] = attribute.getComponent(i, k);
        }
      }
      preBakeSnapshots.set(mesh.uuid, { values, itemSize: attribute.itemSize });
    }
    // 顶点色只有在材质开启 vertexColors 时才会参与相乘
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material) continue;
      if ((material as THREE.MeshBasicMaterial).vertexColors !== true) {
        (material as THREE.MeshBasicMaterial).vertexColors = true;
        material.needsUpdate = true;
      }
    }

    const normals = mesh.geometry.getAttribute('normal');
    for (const i of indices) {
      let ndl = 1;
      if (normals) {
        ndl = Math.max(
          0,
          normals.getX(i) * lx + normals.getY(i) * ly + normals.getZ(i) * lz,
        );
      }
      const shade = Math.min(1, Math.max(0, options.ambient + options.diffuse * ndl));
      const r = options.tint[0] * shade;
      const g = options.tint[1] * shade;
      const b = options.tint[2] * shade;
      attribute.setXYZ(i, r, g, b);
      if (shade < minShade) minShade = shade;
      if (shade > maxShade) maxShade = shade;
      sumR += r;
      sumG += g;
      sumB += b;
      vertices += 1;
    }
    attribute.needsUpdate = true;
    meshes += 1;
  });

  if (!Number.isFinite(minShade)) {
    minShade = 1;
    maxShade = 1;
  }
  const divisor = Math.max(1, vertices);
  return {
    meshes,
    vertices,
    minShade,
    maxShade,
    meanColor: [sumR / divisor, sumG / divisor, sumB / divisor],
  };
}

interface PreBakeSnapshot {
  values: Float32Array;
  itemSize: number;
}

const preBakeSnapshots = new Map<string, PreBakeSnapshot>();

/**
 * 撤销烘焙，把顶点色还原成加载时的原始值（模型原始 `COLOR_0` 全为 1）。
 *
 * 只用于诊断 A/B 对照（`window.diagnostics.setSkinBake(false)`）；
 * 生产路径不会调用。返回实际还原的网格与顶点数。
 */
export function restoreSkinShading(root: THREE.Object3D): { meshes: number; vertices: number } {
  let meshes = 0;
  let vertices = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const snapshot = preBakeSnapshots.get(mesh.uuid);
    if (!snapshot) return;
    const attribute = ensureWritableColors(mesh);
    if (!attribute || attribute.itemSize !== snapshot.itemSize) return;
    (attribute.array as Float32Array).set(snapshot.values);
    attribute.needsUpdate = true;
    meshes += 1;
    vertices += attribute.count;
  });
  return { meshes, vertices };
}

/** 模型销毁时清掉快照，避免跨模型复用 uuid。 */
export function clearSkinShadingCache(): void {
  preBakeSnapshots.clear();
}
