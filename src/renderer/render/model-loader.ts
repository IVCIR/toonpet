/**
 * GLB 加载管线（渲染侧，ADR 0009 D1/D3/D5/D6）。
 *
 * - 字节来自只读 `pet-asset://asset/model`（fetch → ArrayBuffer → GLTFLoader.parse），
 *   渲染进程不碰文件系统；
 * - 取景包围盒与主进程用**同一份**排除规则（query 传入的 frameExclude）与同一份定标公式；
 * - 配件隐藏（ADR 0014 D5）：只 `visible = false`，不删除节点、不改材质；隐藏集合不参与取景；
 * - 材质统一转无光照 `MeshBasicMaterial`：场景没有灯光，PBR 会发黑，二次元贴图已烘焙明暗；
 * - 骨骼按精确名字匹配，缺失只降级不抛错。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { matchesHiddenAttachment } from '../../shared/attachments';
import { pickDominantColor, type Rgb } from '../../shared/color';
import {
  matchesFrameExclude,
  mergeBounds,
  pixelsPerUnitFor,
  type Bounds3,
} from '../../shared/model-frame';

export const MODEL_URL = 'pet-asset://asset/model';

const HEAD_BONE = 'Bip001 Head';
const EYE_L_BONE = 'Bip001 eye_L';
const EYE_R_BONE = 'Bip001 eye_R';
const PELVIS_BONE = 'Bip001 Pelvis';
const SPINE_BONE = 'Bip001 Spine';
const SPINE1_BONE = 'Bip001 Spine1';
const NECK_BONE = 'Bip001 Neck';
const CLAVICLE_L_BONE = 'Bip001 L Clavicle';
const CLAVICLE_R_BONE = 'Bip001 R Clavicle';
const UPPER_ARM_L_BONE = 'Bip001 L UpperArm';
const UPPER_ARM_R_BONE = 'Bip001 R UpperArm';
const FOREARM_L_BONE = 'Bip001 L Forearm';
const FOREARM_R_BONE = 'Bip001 R Forearm';
const HAND_L_BONE = 'Bip001 L Hand';
const HAND_R_BONE = 'Bip001 R Hand';
const THIGH_L_BONE = 'Bip001 L Thigh';
const THIGH_R_BONE = 'Bip001 R Thigh';
const CALF_L_BONE = 'Bip001 L Calf';
const CALF_R_BONE = 'Bip001 R Calf';
const FOOT_L_BONE = 'Bip001 L Foot';
const FOOT_R_BONE = 'Bip001 R Foot';

/**
 * GLTFLoader 会对节点名做 `sanitizeNodeName`（空格→下划线、去掉保留字符），
 * 所以 `Bip001 Head` 在 three 里是 `Bip001_Head`。这里统一归一化后比较，
 * 避免把"名字被清洗"误判成"骨骼缺失"。
 */
function normalizeBoneName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

const BONE_TARGETS = {
  head: normalizeBoneName(HEAD_BONE),
  eyeL: normalizeBoneName(EYE_L_BONE),
  eyeR: normalizeBoneName(EYE_R_BONE),
  pelvis: normalizeBoneName(PELVIS_BONE),
  spine: normalizeBoneName(SPINE_BONE),
  spine1: normalizeBoneName(SPINE1_BONE),
  neck: normalizeBoneName(NECK_BONE),
  clavicleL: normalizeBoneName(CLAVICLE_L_BONE),
  clavicleR: normalizeBoneName(CLAVICLE_R_BONE),
  upperArmL: normalizeBoneName(UPPER_ARM_L_BONE),
  upperArmR: normalizeBoneName(UPPER_ARM_R_BONE),
  forearmL: normalizeBoneName(FOREARM_L_BONE),
  forearmR: normalizeBoneName(FOREARM_R_BONE),
  handL: normalizeBoneName(HAND_L_BONE),
  handR: normalizeBoneName(HAND_R_BONE),
  thighL: normalizeBoneName(THIGH_L_BONE),
  thighR: normalizeBoneName(THIGH_R_BONE),
  calfL: normalizeBoneName(CALF_L_BONE),
  calfR: normalizeBoneName(CALF_R_BONE),
  footL: normalizeBoneName(FOOT_L_BONE),
  footR: normalizeBoneName(FOOT_R_BONE),
} as const;

export interface ModelBones {
  head: THREE.Bone | null;
  eyeL: THREE.Bone | null;
  eyeR: THREE.Bone | null;
  pelvis: THREE.Bone | null;
  /** 脊柱/颈（拖拽姿态与坐姿活体用；缺失只降级，不影响 modelReady） */
  spine: THREE.Bone | null;
  spine1: THREE.Bone | null;
  neck: THREE.Bone | null;
  clavicleL: THREE.Bone | null;
  clavicleR: THREE.Bone | null;
  upperArmL: THREE.Bone | null;
  upperArmR: THREE.Bone | null;
  forearmL: THREE.Bone | null;
  forearmR: THREE.Bone | null;
  handL: THREE.Bone | null;
  handR: THREE.Bone | null;
  /** 大腿/小腿/脚（拖拽悬挂、坐姿降级、落地缓冲用） */
  thighL: THREE.Bone | null;
  thighR: THREE.Bone | null;
  calfL: THREE.Bone | null;
  calfR: THREE.Bone | null;
  footL: THREE.Bone | null;
  footR: THREE.Bone | null;
}

export interface LoadedModel {
  root: THREE.Group;
  frame: Bounds3;
  scene: Bounds3;
  pixelsPerUnit: number;
  modelId: string;
  loadMs: number;
  hasMorphTargets: boolean;
  meshNames: string[];
  materialNames: string[];
  triangleCount: number;
  /** 装配后被隐藏的配件网格名（ADR 0014 D5） */
  hiddenMeshes: string[];
  /** 可见网格（地面校正的采样对象） */
  meshes: THREE.Mesh[];
  /** 模型自带动画（44 段；由 animation-controller 选择与播放） */
  animations: THREE.AnimationClip[];
  bones: ModelBones;
  /**
   * 光环枢轴（`HaloRoot`）。它不是骨骼、不受动画驱动，所以在"角色被搬走"的片段里
   * 会留在原地（ADR 0028 D8 实测）。渲染侧每帧把它挂到头骨上。
   */
  halo: THREE.Object3D | null;
  mouthMaterialName: string | null;
  /** 从 Face 贴图采样的**主色**（众数，不是均值）——给嘴部底板填色用（ADR 0010 D2） */
  skinColor: { r: number; g: number; b: number } | null;
  mouthMaterial: THREE.MeshBasicMaterial | null;
  /** 原 EyeMouth 贴图（阶段 5 合成嘴型时的底图，ADR 0010 D2） */
  mouthSourceTexture: THREE.Texture | null;
  /** 脸皮材质（红晕层画在这张贴图上，ADR 0026 D3.3）；缺失时为 null */
  faceMaterial: THREE.MeshBasicMaterial | null;
  faceMaterialName: string | null;
  faceSourceTexture: THREE.Texture | null;
  dispose(): void;
}

export interface LoadModelOptions {
  modelId: string;
  frameExclude: string;
  /** 装配期配件隐藏正则（ADR 0014 D5） */
  hideAttachments: string;
  contentHeight: number;
  url?: string;
}

function textureHasAlpha(texture: THREE.Texture | null): boolean {
  const image = texture?.image as (CanvasImageSource & { width?: number; height?: number }) | undefined;
  if (!image) return false;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return false;
    context.drawImage(image, 0, 0, 32, 32);
    const data = context.getImageData(0, 0, 32, 32).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i]! < 250) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 采样贴图的**主色**（众数），不是平均色。
 *
 * 为什么不能用 1×1 缩放取平均（上一版的做法）：Face 贴图里除了肤色还有眉毛、
 * 鼻影、下颌阴影与发梢压边，整张平均下来是 `(204,190,186)`，比真实肤色
 * `(249,241,236)` 暗 18%——把嘴部白底板刷成这个颜色，就是脸上的一块暗斑。
 * 实测：众数桶（5bit/通道量化）占 43%，桶内均值 `(249,241,236)`，与目视一致。
 *
 * 取色算法在 `shared/color.ts`（纯函数，可单测）；这里只负责把贴图画进 canvas。
 */
function sampleDominantColor(texture: THREE.Texture | null): Rgb | null {
  const image = texture?.image as (CanvasImageSource & { width?: number; height?: number }) | undefined;
  if (!image) return null;
  try {
    const sourceWidth = image.width ?? 128;
    const sourceHeight = image.height ?? 128;
    const scale = Math.min(1, 256 / Math.max(1, Math.max(sourceWidth, sourceHeight)));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);
    return pickDominantColor(context.getImageData(0, 0, width, height).data);
  } catch {
    return null;
  }
}

function collectBounds(
  meshes: THREE.Mesh[],
  isExcluded: (mesh: THREE.Mesh) => boolean,
): {
  frame: Bounds3 | null;
  scene: Bounds3 | null;
  used: string[];
} {
  const all: Bounds3[] = [];
  const included: Bounds3[] = [];
  const used: string[] = [];
  const box = new THREE.Box3();

  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    if (!geometry) continue;
    geometry.computeBoundingBox();
    if (!geometry.boundingBox) continue;

    box.copy(geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
    const bounds: Bounds3 = {
      minX: box.min.x,
      minY: box.min.y,
      minZ: box.min.z,
      maxX: box.max.x,
      maxY: box.max.y,
      maxZ: box.max.z,
    };
    all.push(bounds);
    if (isExcluded(mesh)) continue;
    included.push(bounds);
    used.push(mesh.name);
  }

  return {
    frame: mergeBounds(included) ?? mergeBounds(all),
    scene: mergeBounds(all),
    used,
  };
}

/**
 * 按当前姿态（已被 mixer 求值过）测一次可见网格的最低点，返回 **root 局部坐标**的 y。
 *
 * 用途（ADR 0014 D4）：自带动画的根骨平移把角色从绑定姿态抬起约 22px，
 * 不校正会"悬空站立"。只做一次 CPU 蒙皮采样（默认每网格 ≤4096 顶点），
 * 不参与逐帧。失败返回 null（调用方保留绑定姿态的放置）。
 */
export function measureAnimatedMinY(
  root: THREE.Object3D,
  meshes: readonly THREE.Mesh[],
  maxSamplesPerMesh = 4096,
): number | null {
  const bounds = measureAnimatedBounds(root, meshes, maxSamplesPerMesh);
  return bounds ? bounds.minY : null;
}

/**
 * 当前姿态的**身体包围盒**（root 局部单位，排除配件：光环/武器/道具/笔刷）。
 *
 * 用途（ADR 0028 D8）：坐姿片段把身体平移了（回忆片段把角色搬到长椅上：
 * cx ≈ -0.0035、minY ≈ +0.0058 单位），直接用会让她悬在窗口左上角；
 * 进入 `sitting` 时按这里的测量值把"身体中心 → 窗口中线、身体最低点 → 窗口底边"。
 *
 * 排除规则与 `HIDE_ATTACHMENTS` 同源：光环会由 `haloFollow` 单独处理，
 * 不能参与"身体"的包围盒，否则包围盒会被拉到光环的位置。
 */
export function measureAnimatedBounds(
  root: THREE.Object3D,
  meshes: readonly THREE.Mesh[],
  maxSamplesPerMesh = 4096,
  excludePattern: RegExp = /(halo|weapon|prop|brush|outline)/i,
): { minX: number; maxX: number; minY: number } | null {
  root.updateMatrixWorld(true);
  const point = new THREE.Vector3();
  const world = new THREE.Vector3();
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let measured = 0;

  for (const mesh of meshes) {
    if (!mesh.visible) continue;
    if (excludePattern.test(mesh.name || '')) continue;
    const geometry = mesh.geometry;
    const position = geometry?.getAttribute('position');
    if (!position || position.count === 0) continue;

    const skinned =
      (mesh as THREE.SkinnedMesh).isSkinnedMesh &&
      geometry.getAttribute('skinIndex') &&
      geometry.getAttribute('skinWeight')
        ? (mesh as THREE.SkinnedMesh)
        : null;
    const stride = Math.max(1, Math.floor(position.count / maxSamplesPerMesh));

    for (let i = 0; i < position.count; i += stride) {
      // applyBoneTransform 要求传入向量里**已经**是顶点位置（内部会再乘 bindMatrix），
      // 直接传 (0,0,0) 等价于只蒙皮"骨骼原点"，会得到远离模型的假最低点。
      point.fromBufferAttribute(position, i);
      if (skinned && skinned.skeleton) {
        skinned.applyBoneTransform(i, point); // 结果在 mesh 局部空间（已含 bindMatrixInverse）
      }
      world.copy(point);
      mesh.localToWorld(world);
      root.worldToLocal(world);
      if (world.y < minY) minY = world.y;
      if (world.x < minX) minX = world.x;
      if (world.x > maxX) maxX = world.x;
      measured += 1;
    }
  }

  if (measured === 0 || !Number.isFinite(minY) || !Number.isFinite(minX) || !Number.isFinite(maxX)) {
    return null;
  }
  return { minX, maxX, minY };
}

/**
 * 把模型放到"脚底锚点"的父节点下（§3.2 锚点）。
 *
 * 约定：调用方把父节点（animationRoot）放在内容区底边中心；本函数只把模型的
 * 取景包围盒底边对齐到父节点原点、水平/前后居中，并设置统一缩放。
 * 可在 resize 时重复调用。
 */
export function placeModel(
  root: THREE.Object3D,
  frame: Bounds3,
  contentHeight: number,
): number {
  const frameHeightUnits = Math.max(1e-9, frame.maxY - frame.minY);
  const pixelsPerUnit = pixelsPerUnitFor(frameHeightUnits, contentHeight);
  const centerX = (frame.minX + frame.maxX) / 2;
  const centerZ = (frame.minZ + frame.maxZ) / 2;

  root.scale.setScalar(pixelsPerUnit);
  root.position.set(
    -centerX * pixelsPerUnit,
    -frame.minY * pixelsPerUnit,
    -centerZ * pixelsPerUnit,
  );
  return pixelsPerUnit;
}

export async function loadModel(options: LoadModelOptions): Promise<LoadedModel> {
  const startedAt = performance.now();

  const response = await fetch(options.url ?? MODEL_URL);
  if (!response.ok) {
    throw new Error(`模型请求失败 HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();

  const gltf = await new Promise<GLTF>((resolve, reject) => {
    new GLTFLoader().parse(
      buffer,
      '',
      (result) => resolve(result),
      (error) => reject(error instanceof Error ? error : new Error(String(error))),
    );
  });

  const scene = gltf.scene;
  scene.updateMatrixWorld(true);

  const meshes: THREE.Mesh[] = [];
  const bones: ModelBones = {
    head: null,
    eyeL: null,
    eyeR: null,
    pelvis: null,
    spine: null,
    spine1: null,
    neck: null,
    clavicleL: null,
    clavicleR: null,
    upperArmL: null,
    upperArmR: null,
    forearmL: null,
    forearmR: null,
    handL: null,
    handR: null,
    thighL: null,
    thighR: null,
    calfL: null,
    calfR: null,
    footL: null,
    footR: null,
  };
  const materialNames = new Set<string>();
  let triangleCount = 0;
  let hasMorphTargets = false;
  /** 光环的枢轴节点（ADR 0028 D8：光环不参与蒙皮，必须跟着头骨走） */
  let halo: THREE.Object3D | null = null;

  scene.traverse((object) => {
    const bone = object as THREE.Bone;
    if (bone.isBone) {
      const normalized = normalizeBoneName(bone.name);
      if (normalized === BONE_TARGETS.head) bones.head = bone;
      else if (normalized === BONE_TARGETS.eyeL) bones.eyeL = bone;
      else if (normalized === BONE_TARGETS.eyeR) bones.eyeR = bone;
      else if (normalized === BONE_TARGETS.pelvis) bones.pelvis = bone;
      else if (normalized === BONE_TARGETS.spine) bones.spine = bone;
      else if (normalized === BONE_TARGETS.spine1) bones.spine1 = bone;
      else if (normalized === BONE_TARGETS.neck) bones.neck = bone;
      else if (normalized === BONE_TARGETS.clavicleL) bones.clavicleL = bone;
      else if (normalized === BONE_TARGETS.clavicleR) bones.clavicleR = bone;
      else if (normalized === BONE_TARGETS.upperArmL) bones.upperArmL = bone;
      else if (normalized === BONE_TARGETS.upperArmR) bones.upperArmR = bone;
      else if (normalized === BONE_TARGETS.forearmL) bones.forearmL = bone;
      else if (normalized === BONE_TARGETS.forearmR) bones.forearmR = bone;
      else if (normalized === BONE_TARGETS.handL) bones.handL = bone;
      else if (normalized === BONE_TARGETS.handR) bones.handR = bone;
      else if (normalized === BONE_TARGETS.thighL) bones.thighL = bone;
      else if (normalized === BONE_TARGETS.thighR) bones.thighR = bone;
      else if (normalized === BONE_TARGETS.calfL) bones.calfL = bone;
      else if (normalized === BONE_TARGETS.calfR) bones.calfR = bone;
      else if (normalized === BONE_TARGETS.footL) bones.footL = bone;
      else if (normalized === BONE_TARGETS.footR) bones.footR = bone;
    }
    // `HaloRoot` 是光环的枢轴（`CH0335_Halo` 的父节点）：它是普通 Object3D，
    // 不在骨骼层级里，也不会被任何片段驱动 —— 角色一移动，光环就留在原地。
    if (normalizeBoneName(object.name) === 'haloroot') halo = object;

    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    meshes.push(mesh);
    // 蒙皮网格的包围球在绑定姿态下可能偏小，直接关掉视锥裁剪避免整块消失
    mesh.frustumCulled = false;
    if ((mesh.geometry.morphAttributes.position?.length ?? 0) > 0) hasMorphTargets = true;
    const index = mesh.geometry.getIndex();
    const position = mesh.geometry.getAttribute('position');
    triangleCount += Math.floor((index ? index.count : position?.count ?? 0) / 3);
  });

  // ADR 0014 D5：配件只做 visible = false（不删节点、不改材质），并且不参与取景
  const hiddenSet = new Set<THREE.Mesh>();
  const hiddenMeshes: string[] = [];
  for (const mesh of meshes) {
    if (!matchesHiddenAttachment(mesh.name, options.hideAttachments)) continue;
    mesh.visible = false;
    hiddenSet.add(mesh);
    hiddenMeshes.push(mesh.name || '(unnamed)');
  }

  const bounds = collectBounds(
    meshes,
    (mesh) => hiddenSet.has(mesh) || matchesFrameExclude(mesh.name, options.frameExclude),
  );
  if (!bounds.frame || !bounds.scene) {
    throw new Error('模型没有任何可用的网格包围盒');
  }

  // 无光照材质转换（保留名字，EyeMouth 用它做阶段 5 的钩子）
  const converted = new Map<THREE.Material, THREE.MeshBasicMaterial>();
  const hasAlphaCache = new Map<THREE.Texture, boolean>();
  const disposeTargets = new Set<THREE.MeshBasicMaterial>();
  // 用持有者对象而不是两个 let：赋值发生在闭包里，TS 的 CFA 会把 let 收窄成 null
  const mouth: {
    material: THREE.MeshBasicMaterial | null;
    sourceTexture: THREE.Texture | null;
  } = { material: null, sourceTexture: null };
  const face: { material: THREE.MeshBasicMaterial | null; map: THREE.Texture | null } = {
    material: null,
    map: null,
  };

  const convertMaterial = (source: THREE.Material): THREE.MeshBasicMaterial => {
    const cached = converted.get(source);
    if (cached) return cached;

    const standard = source as THREE.MeshStandardMaterial;
    const map = standard.map ?? null;
    let alphaTest = 0;
    if (map) {
      let hasAlpha = hasAlphaCache.get(map);
      if (hasAlpha === undefined) {
        hasAlpha = textureHasAlpha(map);
        hasAlphaCache.set(map, hasAlpha);
      }
      alphaTest = hasAlpha ? 0.5 : 0;
    }

    const material = new THREE.MeshBasicMaterial({
      name: source.name,
      map,
      color: standard.color ? standard.color.clone() : new THREE.Color(0xffffff),
      vertexColors: standard.vertexColors ?? false,
      transparent: false,
      alphaTest,
      side: THREE.DoubleSide,
      toneMapped: false,
      depthWrite: true,
    });
    converted.set(source, material);
    disposeTargets.add(material);
    materialNames.add(material.name || '(unnamed)');

    if (/EyeMouth/i.test(material.name)) {
      mouth.material = material;
      mouth.sourceTexture = map;
    }
    if (/(^|_)Face$/i.test(material.name)) {
      face.material = material;
      face.map = map;
    }
    return material;
  };

  for (const mesh of meshes) {
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((material) => convertMaterial(material));
    } else if (mesh.material) {
      mesh.material = convertMaterial(mesh.material);
    }
  }

  const root = new THREE.Group();
  root.name = 'model-root';
  root.add(scene);

  const pixelsPerUnit = placeModel(root, bounds.frame, options.contentHeight);
  root.updateMatrixWorld(true);

  // 原材质与几何不再需要：材质已替换，几何由 root 持有
  for (const source of converted.keys()) source.dispose();

  const loadMs = performance.now() - startedAt;

  return {
    root,
    frame: bounds.frame,
    scene: bounds.scene,
    pixelsPerUnit,
    modelId: options.modelId,
    loadMs,
    hasMorphTargets,
    meshNames: meshes.map((mesh) => mesh.name),
    materialNames: [...materialNames],
    triangleCount,
    hiddenMeshes,
    meshes,
    animations: gltf.animations ?? [],
    bones,
    halo,
    mouthMaterialName: mouth.material?.name ?? null,
    skinColor: sampleDominantColor(face.map),
    mouthMaterial: mouth.material,
    mouthSourceTexture: mouth.sourceTexture,
    faceMaterial: face.material,
    faceMaterialName: face.material?.name ?? null,
    faceSourceTexture: face.map,
    dispose(): void {
      const textures = new Set<THREE.Texture>();
      for (const material of disposeTargets) {
        if (material.map) textures.add(material.map);
        material.dispose();
      }
      for (const texture of textures) texture.dispose();
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh && mesh.geometry) mesh.geometry.dispose();
      });
    },
  };
}
