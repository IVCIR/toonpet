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
}

interface SurfacePatch {
  center: THREE.Vector3;
  /** 世界空间的尺寸 */
  width: number;
  height: number;
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
const EYE_PLANE_SCALE_X = 1.0; // 相对"半宽"（一只眼）
const EYE_PLANE_SCALE_Y = 0.62; // 相对整块高度
const EYE_PLANE_OFFSET_Y = 0.12; // 相对整块高度，正值向上
const MOUTH_PLANE_SCALE_X = 0.95;
const MOUTH_PLANE_SCALE_Y = 1.0;
const BLUSH_PLANE_SCALE_X = 0.42;
const BLUSH_PLANE_SCALE_Y = 0.5;
const BLUSH_OFFSET_Y = 0.35; // 眼睛中心往下多少（相对整块高度）
const BLUSH_OFFSET_X = 1.35; // 眼睛中心往外多少（相对半宽）
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
    return { center, width: size.x, height: size.y };
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
      dispose() {},
    };
  }

  const eyeTexture = toTexture(assets.eyesClosed);
  const eyeTextureMirrored = toTexture(assets.eyesClosed, true);
  const mouthLineTexture = toTexture(assets.mouthLine);
  const mouthOpenTexture = toTexture(assets.mouthOpen);
  const blushTexture = toTexture(assets.blush);

  // 量出来的面片是**世界坐标**（模型根带 pixelsPerUnit 缩放，世界单位≈像素）；
  // 贴花挂在头骨下，必须换算回骨骼局部空间，否则尺寸会差 5 万倍。
  const worldScale = headBone.getWorldScale(new THREE.Vector3()).x || 1;
  const toLocal = (world: THREE.Vector3): THREE.Vector3 => headBone.worldToLocal(world.clone());
  const liftWorld = SURFACE_LIFT * worldScale;

  const halfEyeWidthWorld = patches.eye.width / 4;
  const eyeYWorld = patches.eye.center.y + patches.eye.height * EYE_PLANE_OFFSET_Y;
  // 所有平面共用同一个 Z（眼睛那块脸的表面），不要用嘴底板自己的 Z——实测它靠前 18px
  const faceZWorld = patches.eye.center.z + liftWorld;

  const leftEyePos = toLocal(new THREE.Vector3(-halfEyeWidthWorld, eyeYWorld, faceZWorld));
  const rightEyePos = toLocal(new THREE.Vector3(halfEyeWidthWorld, eyeYWorld, faceZWorld));

  const debugColor = options.debugColor ?? null;
  const leftEye = makePlane(
    eyeTexture,
    ((patches.eye.width / 2) * EYE_PLANE_SCALE_X) / worldScale,
    (patches.eye.height * EYE_PLANE_SCALE_Y) / worldScale,
    1,
    debugColor,
  );
  leftEye.position.copy(leftEyePos);

  const rightEye = makePlane(
    eyeTextureMirrored,
    ((patches.eye.width / 2) * EYE_PLANE_SCALE_X) / worldScale,
    (patches.eye.height * EYE_PLANE_SCALE_Y) / worldScale,
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
  headBone.add(group);

  // 调试模式：所有平面立刻可见（生产路径下由 setBlink / setMouthOpen 控制）
  if (debugColor !== null) {
    for (const plane of [leftEye, rightEye, mouth, leftBlush, rightBlush]) {
      plane.visible = true;
    }
  }

  // 贴花随头骨走，但朝向"世界 +Z"（面朝镜头）：把头的世界朝向抵消掉
  const headQuat = new THREE.Quaternion();
  headBone.getWorldQuaternion(headQuat);
  const cancel = headQuat.clone().invert();
  for (const plane of [leftEye, rightEye, mouth, leftBlush, rightBlush]) {
    plane.quaternion.copy(cancel);
  }

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
      // 用不透明度做交叉淡入：线稿是细线，直接切换会闪
      const leftMaterial = leftEye.material as THREE.MeshBasicMaterial;
      const rightMaterial = rightEye.material as THREE.MeshBasicMaterial;
      leftMaterial.opacity = next;
      rightMaterial.opacity = next;
      leftEye.visible = next > 0.02;
      rightEye.visible = next > 0.02;
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
      // 贴花是头骨的子节点，骨骼动画会自动带着它走；这里只保持朝向镜头
      if (!headBone.parent) return;
      headBone.getWorldQuaternion(headQuat);
      cancel.copy(headQuat).invert();
      for (const plane of [leftEye, rightEye, mouth, leftBlush, rightBlush]) {
        plane.quaternion.copy(cancel);
      }
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

    dispose(): void {
      headBone.remove(group);
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
