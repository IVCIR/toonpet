/**
 * 官方线稿贴花层（ADR 0026 D7）。
 *
 * 为什么是贴花而不是往 EyeMouth 贴图里画：
 * 官方给 3D 小人换表情的做法本身就是**平面贴花**——`FX_MESH_CH0335_Prop_Face_01/02/03.glb`
 * 是 z=0 的平面，配 `FX_TEX_CH0335_Img_Face_01.png`（3×3 线稿：3 种眼型 × 左右 + 3 条嘴线）。
 * 线稿只有"线"，没有肤色底，投影进眼部 UV 会把原虹膜露出来；贴花天生就是叠加层。
 *
 * 为什么不是屏幕空间 overlay：那会盖在刘海之上。这里的平面参与**深度测试**
 * （`depthTest: true`），位置在脸部表面略靠前，刘海挡在它前面时仍然会遮挡——
 * 与真实眼睛的遮挡关系一致（ADR 0026 D2.1 的结论不变）。
 */
import * as THREE from 'three';

export interface FaceDecalAssets {
  eyesClosed: CanvasImageSource | null;
  mouthLine: CanvasImageSource | null;
  mouthOpen: CanvasImageSource | null;
  blush: CanvasImageSource | null;
  /** 官方遮罩（`FX_TEX_CH0335_Img_Face_02` 转成的 alpha 图）：白 = 盖住，透明 = 不盖 */
  eyeMask: CanvasImageSource | null;
}

export interface FaceDecalDiagnostics {
  ready: boolean;
  eyePlanes: number;
  mouth: boolean;
  blush: boolean;
  /** 平面中心（世界坐标，bind pose） */
  eyeCenter: [number, number, number] | null;
  mouthCenter: [number, number, number] | null;
  /** 量出来的面片尺寸（世界单位≈像素），用于标定缩放 */
  eyePatch: [number, number] | null;
  mouthPatch: [number, number] | null;
  blink: number;
  mouthOpen: number;
  blushLevel: number;
  reason: string | null;
}

export interface FaceDecal {
  /** 0 = 睁眼，1 = 闭眼 */
  setBlink(amount: number): void;
  /** 0 = 闭嘴，1 = 张口 */
  setMouthOpen(amount: number): void;
  /** 0 = 无红晕，1 = 最浓 */
  setBlush(amount: number): void;
  /** 每帧调用：把贴花钉在骨骼上（骨骼动它就动） */
  update(): void;
  diagnostics(): FaceDecalDiagnostics;
  /** 调试：各平面的世界坐标（顺序：左眼、右眼、嘴、左腮红、右腮红） */
  debugWorldPositions(): Array<[number, number, number]>;
  /** 调试：每个平面的可见性/不透明度/贴图状态 */
  debugPlaneInfo(): string;
  dispose(): void;
}

export interface FaceDecalOptions {
  /** 头骨（贴花挂在它下面，随动画走） */
  headBone: THREE.Bone | null;
  /** 模型根（用于世界坐标换算） */
  root: THREE.Object3D;
  meshes: readonly THREE.Mesh[];
  assets: FaceDecalAssets;
  /**
   * 视觉调试用：给定时所有平面用这个纯色、不透明渲染（忽略贴图）。
   * 用来确认"平面在哪、多大、朝哪"——比看线稿直观得多。
   */
  debugColor?: number | null;
  /** 肤色（遮盖平面用）；缺失时用默认肤色 */
  skinColor?: { r: number; g: number; b: number } | null;
}

interface SurfacePatch {
  center: THREE.Vector3;
  /** 世界空间的尺寸 */
  width: number;
  height: number;
  /** 包围盒最靠前（+Z）的坐标：贴花必须放在它前面，否则会被脸自身挡住 */
  frontZ: number;
}

/** 贴花平面相对脸皮的抬升量（模型单位）。太小会 z-fighting，太大会浮起来。 */
const SURFACE_LIFT = 0.00012;

/**
 * 视觉标定（硬编码，靠截图调）。
 *
 * 为什么不自动换算：量出来的 `eyePatch` 是**双眼连同睫毛**的包围盒（116×57），
 * 直接铺满会盖住鼻子；线稿本身只画了眼睛那一条弧。所以宽高各乘一个手调系数，
 * 并整体上移一点。换模型必须重标（写进 MODULE_STATUS 坑位）。
 */
const EYE_PLANE_SCALE_X = 0.82; // 相对"半宽"（一只眼）
const EYE_PLANE_SCALE_Y = 0.62; // 相对整块高度（保留：仅用于未提供贴图宽高比时）
const EYE_PLANE_OFFSET_Y = -0.08; // 相对整块高度，正值向上；负值下移（包围盒含眉毛，眼珠偏下）
const MOUTH_PLANE_SCALE_X = 0.95;
const MOUTH_PLANE_SCALE_Y = 1.0;
const BLUSH_PLANE_SCALE_X = 0.42;
const BLUSH_PLANE_SCALE_Y = 0.5;
const BLUSH_OFFSET_Y = 0.35; // 眼睛中心往下多少（相对整块高度）
const BLUSH_OFFSET_X = 1.35; // 眼睛中心往外多少（相对半宽）

/** 官方遮罩图（493×155）的宽高比与相对眼块的放大倍数。 */
const EYE_MASK_ASPECT = 155 / 493;
const EYE_MASK_SCALE_X = 1.33;
/** 平面尺寸相对 UV 岛包围盒的放大（线稿比几何略大一圈，避免边缘被裁）。 */
const PATCH_SCALE = 1.25;

function materialName(mesh: THREE.Mesh): string {
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  return material?.name ?? '';
}

/**
 * 从 `EyeMouth` 网格里量出"眼部"和"嘴底板"两块面片的世界坐标中心与尺寸。
 *
 * 用 UV 区分两块：嘴底板的 UV 岛在 `u<0.25 && v>0.75`（ADR 0026 实测），其余是眼睛。
 * 顶点在**蒙皮前的局部空间**，所以要过一遍 `matrixWorld`。
 */
function measurePatches(mesh: THREE.Mesh): { eye: SurfacePatch | null; mouth: SurfacePatch | null } {
  const geometry = mesh.geometry as THREE.BufferGeometry;
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  if (!position || !uv) return { eye: null, mouth: null };

  mesh.updateWorldMatrix(true, false);
  const matrix = mesh.matrixWorld;
  // `EyeMouth` 是 SkinnedMesh：几何体顶点在**绑定空间**，真实位置要过蒙皮矩阵。
  // 直接乘 matrixWorld 会得到"绑定姿态 + 未蒙皮"的错位置（实测红块盖在鼻嘴上）。
  const skinned = mesh as THREE.SkinnedMesh;
  const useSkinning = Boolean(skinned.isSkinnedMesh && typeof skinned.applyBoneTransform === 'function');

  const eyeBox = new THREE.Box3();
  const mouthBox = new THREE.Box3();
  const point = new THREE.Vector3();

  const index = geometry.getIndex();
  const triangleCount = index ? index.count / 3 : position.count / 3;
  for (let t = 0; t < triangleCount; t += 1) {
    const ia = index ? index.getX(t * 3) : t * 3;
    const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    const u = (uv.getX(ia) + uv.getX(ib) + uv.getX(ic)) / 3;
    const v = (uv.getY(ia) + uv.getY(ib) + uv.getY(ic)) / 3;
    const target = u < 0.25 && v > 0.75 ? mouthBox : eyeBox;
    for (const i of [ia, ib, ic]) {
      point.set(position.getX(i), position.getY(i), position.getZ(i));
      if (useSkinning) skinned.applyBoneTransform(i, point);
      point.applyMatrix4(matrix);
      target.expandByPoint(point);
    }
  }

  const toPatch = (box: THREE.Box3): SurfacePatch | null => {
    if (box.isEmpty()) return null;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    return { center, width: size.x, height: size.y, frontZ: box.max.z };
  };
  return { eye: toPatch(eyeBox), mouth: toPatch(mouthBox) };
}

function makePlane(
  texture: THREE.Texture | null,
  width: number,
  height: number,
  opacity: number,
  debugColor?: number | null,
): THREE.Mesh {
  const material = new THREE.MeshBasicMaterial(
    debugColor === null || debugColor === undefined
      ? {
          map: texture,
          transparent: true,
          opacity,
          depthTest: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          toneMapped: false,
        }
      : {
          color: debugColor,
          transparent: false,
          opacity: 1,
          depthTest: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          toneMapped: false,
        },
  );
  // 与脸皮共面时避免 z-fighting：向相机方向偏移一个深度单位
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  material.polygonOffsetUnits = -2;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;
  mesh.visible = false;
  // 调试期强制关闭深度测试（贴花必须压在脸上，不能被脸自身挡掉）
  material.depthTest = false;
  return mesh;
}

function toTexture(source: CanvasImageSource | null, flipX = false): THREE.Texture | null {
  if (!source) return null;
  const texture = new THREE.Texture(source as HTMLImageElement);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  if (flipX) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.repeat.x = -1;
    texture.offset.x = 1;
  }
  texture.needsUpdate = true;
  return texture;
}

export function createFaceDecal(options: FaceDecalOptions): FaceDecal {
  const { headBone, meshes, assets } = options;
  const eyeMesh = meshes.find((mesh) => materialName(mesh) === 'CH0335_EyeMouth') ?? null;

  const group = new THREE.Group();
  group.name = 'face-decal';

  const diagnostics: FaceDecalDiagnostics = {
    ready: false,
    eyePlanes: 0,
    mouth: false,
    blush: false,
    eyeCenter: null,
    mouthCenter: null,
    eyePatch: null,
    mouthPatch: null,
    blink: 0,
    mouthOpen: 0,
    blushLevel: 0,
    reason: null,
  };

  if (!headBone || !eyeMesh) {
    diagnostics.reason = headBone ? '未找到 EyeMouth 网格' : '未找到头骨';
    return {
      setBlink() {},
      setMouthOpen() {},
      setBlush() {},
      update() {},
      diagnostics: () => diagnostics,
      debugWorldPositions: () => [],
      debugPlaneInfo: () => 'decal-unavailable',
      dispose() {},
    };
  }

  const patches = measurePatches(eyeMesh);
  if (!patches.eye) {
    diagnostics.reason = 'EyeMouth 网格没有可用的 UV/顶点';
    return {
      setBlink() {},
      setMouthOpen() {},
      setBlush() {},
      update() {},
      diagnostics: () => diagnostics,
      debugWorldPositions: () => [],
      debugPlaneInfo: () => 'decal-unavailable',
      dispose() {},
    };
  }

  const eyeTexture = toTexture(assets.eyesClosed);
  const eyeTextureMirrored = toTexture(assets.eyesClosed, true);
  const mouthLineTexture = toTexture(assets.mouthLine);
  const mouthOpenTexture = toTexture(assets.mouthOpen);
  const blushTexture = toTexture(assets.blush);
  const maskTexture = toTexture(assets.eyeMask);

  // 量出来的面片是**世界坐标**（模型根带 pixelsPerUnit 缩放，世界单位≈像素）；
  // 贴花挂在根节点下（**不挂骨骼**：骨骼子 Mesh 的包围盒不会被正确重算，实测整层不出画），
  // 所以位置要换算回根节点局部空间。
  const worldScale = options.root.getWorldScale(new THREE.Vector3()).x || 1;
  const toLocal = (world: THREE.Vector3): THREE.Vector3 => options.root.worldToLocal(world.clone());
  const liftWorld = SURFACE_LIFT * worldScale;

  const halfEyeWidthWorld = patches.eye.width / 4;
  const eyeYWorld = patches.eye.center.y + patches.eye.height * EYE_PLANE_OFFSET_Y;
  // 所有平面共用同一个 Z：取**包围盒最前面**（眼睛几何有 0.001 的厚度，
  // 用中心会被脸自身挡住——实测遮盖层完全不显示）
  const faceZWorld = patches.eye.frontZ + liftWorld;

  const leftEyePos = toLocal(new THREE.Vector3(-halfEyeWidthWorld, eyeYWorld, faceZWorld));
  const rightEyePos = toLocal(new THREE.Vector3(halfEyeWidthWorld, eyeYWorld, faceZWorld));

  const debugColor = options.debugColor ?? null;
  // 线稿贴图的宽高比：平面必须按它来，否则弧线会被拉成"香蕉"（实测 3:1 的弧贴到 1.6:1 上）
  const closedSource = assets.eyesClosed as { width?: number; height?: number } | null;
  const closedAspect =
    closedSource?.width && closedSource?.height ? closedSource.width / closedSource.height : 3.1;
  const eyePlaneWidth = (patches.eye.width / 2) * EYE_PLANE_SCALE_X;
  const eyePlaneHeight = eyePlaneWidth / closedAspect;
  const leftEye = makePlane(
    eyeTexture,
    eyePlaneWidth / worldScale,
    eyePlaneHeight / worldScale,
    1,
    debugColor,
  );
  leftEye.position.copy(leftEyePos);

  const rightEye = makePlane(
    eyeTextureMirrored,
    eyePlaneWidth / worldScale,
    eyePlaneHeight / worldScale,
    1,
    debugColor,
  );
  rightEye.position.copy(rightEyePos);

  const mouthPatch = patches.mouth;
  const mouth = makePlane(
    mouthLineTexture,
    ((mouthPatch?.width ?? patches.eye.width / 2) * MOUTH_PLANE_SCALE_X) / worldScale,
    ((mouthPatch?.height ?? patches.eye.height) * MOUTH_PLANE_SCALE_Y) / worldScale,
    1,
    debugColor,
  );
  mouth.position.copy(
    toLocal(
      new THREE.Vector3(
        mouthPatch?.center.x ?? 0,
        mouthPatch?.center.y ?? eyeYWorld - patches.eye.height,
        faceZWorld,
      ),
    ),
  );

  // 腮红：眼睛中心往外、往下各推一点（左右各一）
  const blushWidth = (patches.eye.width * BLUSH_PLANE_SCALE_X) / worldScale;
  const blushHeight = (patches.eye.height * BLUSH_PLANE_SCALE_Y) / worldScale;
  const leftBlush = makePlane(blushTexture, blushWidth, blushHeight, 0, debugColor);
  leftBlush.position.copy(
    toLocal(
      new THREE.Vector3(
        -halfEyeWidthWorld * BLUSH_OFFSET_X,
        eyeYWorld - patches.eye.height * BLUSH_OFFSET_Y,
        faceZWorld,
      ),
    ),
  );
  const rightBlush = makePlane(blushTexture, blushWidth, blushHeight, 0, debugColor);
  rightBlush.position.copy(
    toLocal(
      new THREE.Vector3(
        halfEyeWidthWorld * BLUSH_OFFSET_X,
        eyeYWorld - patches.eye.height * BLUSH_OFFSET_Y,
        faceZWorld,
      ),
    ),
  );

  group.add(leftEye, rightEye, mouth, leftBlush, rightBlush);

  // 中层：肤色遮盖平面（官方遮罩 → alpha）。眨眼时把原生睁眼盖成肤色，
  // 否则闭眼线会叠在睁眼上，出现"重瞳"。
  const skin = options.skinColor ?? { r: 249, g: 241, b: 236 };
  const coverWidth = (eyePlaneWidth * 1.15) / worldScale;
  const coverHeight = coverWidth * EYE_MASK_ASPECT;
  const coverMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(`rgb(${skin.r}, ${skin.g}, ${skin.b})`),
    // 用 `map` 而不是 `alphaMap`：遮罩形状存在**alpha 通道**里，
    // 而 `alphaMap` 读的是绿通道（我们这张图绿通道恒为 255 → 整块不透明，实测盖成大方块）。
    map: maskTexture,
    transparent: true,
    opacity: 0,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  coverMaterial.polygonOffset = true;
  coverMaterial.polygonOffsetFactor = -1;
  coverMaterial.polygonOffsetUnits = -1;
  const cover = new THREE.Mesh(new THREE.PlaneGeometry(coverWidth, coverHeight), coverMaterial);
  cover.renderOrder = 1;
  cover.frustumCulled = false;
  cover.visible = false;
  cover.position.copy(
    toLocal(new THREE.Vector3(patches.eye.center.x, eyeYWorld, faceZWorld)),
  );
  group.add(cover);

  // 挂根节点（不挂骨骼）：骨骼子 Mesh 的包围盒不会被正确重算，实测整层不出画。
  // 头骨的世界位移在 `update()` 里逐帧同步到 group 上，所以看起来仍然"跟着头走"。
  options.root.add(group);

  // 调试模式：所有平面立刻可见（生产路径下由 setBlink / setMouthOpen 控制）
  if (debugColor !== null) {
    for (const plane of [leftEye, rightEye, mouth, leftBlush, rightBlush, cover]) {
      plane.visible = true;
    }
  }

  // 朝向"世界 +Z"（面朝镜头）：抵消根节点的世界朝向
  const rootQuat = new THREE.Quaternion();
  options.root.getWorldQuaternion(rootQuat);
  const cancel = rootQuat.clone().invert();
  for (const plane of [leftEye, rightEye, mouth, leftBlush, rightBlush, cover]) {
    plane.quaternion.copy(cancel);
  }

  // 头骨在"装配那一刻"的世界位置：之后每帧用它算位移增量
  const headBaseWorld = headBone.getWorldPosition(new THREE.Vector3());
  const headNowWorld = new THREE.Vector3();
  const groupBaseLocal = group.position.clone();
  const delta = new THREE.Vector3();

  diagnostics.ready = Boolean(eyeTexture);
  diagnostics.eyePlanes = [leftEye, rightEye].filter((plane) => plane.material).length;
  diagnostics.mouth = Boolean(mouthLineTexture);
  diagnostics.blush = Boolean(blushTexture);
  diagnostics.eyeCenter = [patches.eye.center.x, patches.eye.center.y, patches.eye.center.z];
  diagnostics.eyePatch = [patches.eye.width, patches.eye.height];
  diagnostics.mouthPatch = mouthPatch ? [mouthPatch.width, mouthPatch.height] : null;
  diagnostics.mouthCenter = mouthPatch
    ? [mouthPatch.center.x, mouthPatch.center.y, mouthPatch.center.z]
    : null;

  let blink = 0;
  let mouthOpen = 0;
  let blushLevel = 0;
  let mouthShowsOpen = false;

  return {
    setBlink(amount: number): void {
      const next = Math.min(1, Math.max(0, amount));
      blink = next;
      diagnostics.blink = next;
      // 三层同时显隐：肤色遮盖（中层）先盖住原生睁眼，闭眼线稿（顶层）再画上去。
      // 只做透明度交叉淡入——线稿是细线，直接切换会闪。
      const leftMaterial = leftEye.material as THREE.MeshBasicMaterial;
      const rightMaterial = rightEye.material as THREE.MeshBasicMaterial;
      leftMaterial.opacity = next;
      rightMaterial.opacity = next;
      leftEye.visible = next > 0.02;
      rightEye.visible = next > 0.02;
      // 遮盖层跟着一起出现/消失；`alphaMap` 保证只盖眼形区域
      coverMaterial.opacity = next;
      cover.visible = next > 0.02;
    },

    setMouthOpen(amount: number): void {
      const next = Math.min(1, Math.max(0, amount));
      mouthOpen = next;
      diagnostics.mouthOpen = next;
      const material = mouth.material as THREE.MeshBasicMaterial;
      const wantOpen = next > 0.5;
      if (wantOpen !== mouthShowsOpen) {
        mouthShowsOpen = wantOpen;
        material.map = wantOpen ? mouthOpenTexture : mouthLineTexture;
        material.needsUpdate = true;
      }
      // 张口时线稿略放大，避免看起来"只是换了张图"
      const scale = 1 + next * 0.35;
      mouth.scale.set(scale, scale, 1);
      mouth.visible = true;
    },

    setBlush(amount: number): void {
      const next = Math.min(1, Math.max(0, amount));
      blushLevel = next;
      diagnostics.blushLevel = next;
      for (const plane of [leftBlush, rightBlush]) {
        const material = plane.material as THREE.MeshBasicMaterial;
        material.opacity = next * 0.85;
        plane.visible = next > 0.02;
      }
    },

    update(): void {
      // 贴花挂在根节点上（不挂骨骼），所以每帧把头骨的世界位移增量同步过来：
      // 视觉上仍然"跟着头走"，但避开了骨骼子 Mesh 被剔除的坑。
      if (!headBone.parent) return;
      headBone.getWorldPosition(headNowWorld);
      delta.copy(headNowWorld).sub(headBaseWorld).divideScalar(worldScale);
      group.position.copy(groupBaseLocal).add(delta);
    },

    diagnostics(): FaceDecalDiagnostics {
      return { ...diagnostics };
    },

    debugWorldPositions(): Array<[number, number, number]> {
      const out: Array<[number, number, number]> = [];
      const world = new THREE.Vector3();
      for (const plane of [leftEye, rightEye, mouth, leftBlush, rightBlush]) {
        plane.getWorldPosition(world);
        out.push([world.x, world.y, world.z]);
      }
      return out;
    },

    debugPlaneInfo(): string {
      const parts: string[] = [];
      const names = ['eyeL', 'eyeR', 'mouth', 'blushL', 'blushR', 'cover'];
      const planes = [leftEye, rightEye, mouth, leftBlush, rightBlush, cover];
      for (let i = 0; i < planes.length; i += 1) {
        const plane = planes[i];
        const material = plane.material as THREE.MeshBasicMaterial;
        const world = new THREE.Vector3();
        plane.getWorldPosition(world);
        parts.push(
          `${names[i]}:vis=${plane.visible} op=${material.opacity.toFixed(2)} ` +
            `map=${material.map ? `${material.map.image ? 'img' : 'empty'}` : 'null'} ` +
            `z=${world.z.toFixed(1)} w=${(plane.geometry as THREE.PlaneGeometry).parameters.width.toFixed(3)}`,
        );
      }
      return parts.join(' | ');
    },

    dispose(): void {
      options.root.remove(group);
      for (const plane of [leftEye, rightEye, mouth, leftBlush, rightBlush]) {
        plane.geometry.dispose();
        const material = plane.material as THREE.MeshBasicMaterial;
        material.map?.dispose();
        material.dispose();
      }
      group.clear();
    },
  };
}
