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
  dispose(): void;
}

export interface FaceDecalOptions {
  /** 头骨（贴花挂在它下面，随动画走） */
  headBone: THREE.Bone | null;
  /** 模型根（用于世界坐标换算） */
  root: THREE.Object3D;
  meshes: readonly THREE.Mesh[];
  assets: FaceDecalAssets;
}

interface SurfacePatch {
  center: THREE.Vector3;
  /** 世界空间的尺寸 */
  width: number;
  height: number;
}

/** 贴花平面相对脸皮的抬升量（模型单位）。太小会 z-fighting，太大会浮起来。 */
const SURFACE_LIFT = 0.00012;
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
      point.set(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(matrix);
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
): THREE.Mesh {
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
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
  const eyeYWorld = patches.eye.center.y;
  const faceZWorld = patches.eye.center.z + liftWorld;

  const leftEyePos = toLocal(new THREE.Vector3(-halfEyeWidthWorld, eyeYWorld, faceZWorld));
  const rightEyePos = toLocal(new THREE.Vector3(halfEyeWidthWorld, eyeYWorld, faceZWorld));

  const leftEye = makePlane(
    eyeTexture,
    ((patches.eye.width / 2) * PATCH_SCALE) / worldScale,
    (patches.eye.height * PATCH_SCALE * 1.4) / worldScale,
    1,
  );
  leftEye.position.copy(leftEyePos);

  const rightEye = makePlane(
    eyeTextureMirrored,
    ((patches.eye.width / 2) * PATCH_SCALE) / worldScale,
    (patches.eye.height * PATCH_SCALE * 1.4) / worldScale,
    1,
  );
  rightEye.position.copy(rightEyePos);

  const mouthPatch = patches.mouth;
  const mouth = makePlane(
    mouthLineTexture,
    ((mouthPatch?.width ?? patches.eye.width / 2) * 1.1) / worldScale,
    ((mouthPatch?.height ?? patches.eye.height) * 1.6) / worldScale,
    1,
  );
  if (mouthPatch) {
    mouth.position.copy(
      toLocal(
        new THREE.Vector3(
          mouthPatch.center.x,
          mouthPatch.center.y,
          mouthPatch.center.z + liftWorld,
        ),
      ),
    );
  } else {
    mouth.position.copy(toLocal(new THREE.Vector3(0, eyeYWorld - patches.eye.height * 1.4, faceZWorld)));
  }

  // 腮红：从眼睛外下方推出去（左右各一），尺寸按眼宽估算
  const blushWidth = (patches.eye.width * 0.5) / worldScale;
  const blushHeight = (patches.eye.height * 1.1) / worldScale;
  const leftBlush = makePlane(blushTexture, blushWidth, blushHeight, 0);
  leftBlush.position.copy(
    toLocal(
      new THREE.Vector3(
        -halfEyeWidthWorld * 1.55,
        eyeYWorld - patches.eye.height * 0.95,
        faceZWorld,
      ),
    ),
  );
  const rightBlush = makePlane(blushTexture, blushWidth, blushHeight, 0);
  rightBlush.position.copy(
    toLocal(
      new THREE.Vector3(
        halfEyeWidthWorld * 1.55,
        eyeYWorld - patches.eye.height * 0.95,
        faceZWorld,
      ),
    ),
  );

  group.add(leftEye, rightEye, mouth, leftBlush, rightBlush);
  headBone.add(group);

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
