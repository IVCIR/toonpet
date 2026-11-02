/**
 * 背面法描边（Inverted Hull，ADR 0038）。
 *
 * 做法：给每个需要描边的网格克隆一份**同一几何**的网格，材质用
 * `side: BackSide` + 顶点着色器里"沿视空间法线外扩 N 个像素"，片元只输出纯色。
 * 只有背面在轮廓处露出来，于是形成一圈等宽的深色线。
 *
 * 为什么不用后处理：透明置顶窗口下多一张 RenderTarget + 全屏 pass，代价与
 * 128×72 掩膜采集叠加；而这里每个描边网格只是**多一次 draw call**（本资产 3 次）。
 *
 * 为什么外扩按**屏幕像素**（见 `OUTLINE_WIDTH` 的注释）：相机是正交的、世界单位
 * = CSS px，所以视空间 xy 上外扩 N 个单位就是 N 个像素，天然等宽，且不受
 * 呼吸压扁（`animationRoot.scale.y`）与缩放影响。
 *
 * 蒙皮：描边用 `mesh.clone()` 得到，`SkinnedMesh.copy()` 会**共享同一个
 * `Skeleton`** 与绑定矩阵，所以骨骼一动描边跟着动，不需要第二套动画状态。
 */
import * as THREE from 'three';
import {
  OUTLINE_COLOR,
  OUTLINE_DEPTH_BIAS,
  OUTLINE_HAIR_WIDTH,
  OUTLINE_WIDTH,
} from '../../shared/constants';

/**
 * 需要描边的材质：身体、头发、脸。
 * 眼睛/嘴（EyeMouth）不描边——那层是贴图，描边会在眼眶上压出一条黑线；
 * 光环/武器/道具/笔刷默认不描边（发光体/细杆件描边容易糊成黑块）。
 */
export const OUTLINE_TARGET_PATTERN = /^(?:.*_)?(?:Body|Hair|Face)$/i;
/** 明确排除（即使名字里带 Body/Face 也不描边）。 */
export const OUTLINE_EXCLUDE_PATTERN = /eyemouth|eyebrow|halo|weapon|prop|brush|outline/i;

/** 这个材质名要不要描边。 */
export function isOutlineMaterialName(name: string | null | undefined): boolean {
  if (!name) return false;
  if (OUTLINE_EXCLUDE_PATTERN.test(name)) return false;
  return OUTLINE_TARGET_PATTERN.test(name);
}

export const OUTLINE_VERTEX_SHADER = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>

uniform float outlineWidth;
uniform float outlineDepthBias;

void main() {
  // 1) 取（并蒙皮）法线：Skinning 时 objectNormal 已经被 skinMatrix 变换
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>

  // 2) 取（并蒙皮）位置
  #include <begin_vertex>
  #include <skinning_vertex>

  vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );

  // 3) 视空间法线 → 屏幕上沿法线外扩 N 个像素。
  //    正交相机下 view 空间 1 单位 = 1 CSS px，所以宽度与深度无关。
  //
  //    注意这里**不做归一化**：正对镜头的面（len→0）本来就不该外扩，一旦归一化，
  //    len 的浮点噪声会被放大成一个随机方向，表现为平面上一片脏边（实测：
  //    头发卡片 + 脸皮上会出现楔形黑块）。改成乘 smoothstep 让它在 len→0 时
  //    平滑归零、在轮廓（len≈1）处保持满宽。
  vec3 viewNormal = normalize( normalMatrix * objectNormal );
  vec2 dir = viewNormal.xy;
  float len = length( dir );
  dir *= smoothstep( 0.02, 0.30, len );

  mvPosition.xy += dir * outlineWidth;
  // 4) 沿视线方向推远一点，避免与共面/近共面的表面打架
  mvPosition.z -= outlineDepthBias;

  gl_Position = projectionMatrix * mvPosition;
}
`;

export const OUTLINE_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 outlineColor;

void main() {
  gl_FragColor = vec4( outlineColor, 1.0 );
  #include <colorspace_fragment>
}
`;

export interface OutlineOptions {
  /** 屏幕像素宽度 */
  width?: number;
  /** 0xRRGGBB（sRGB） */
  color?: number;
  /** 视空间深度偏移（px） */
  depthBias?: number;
  /** 复用现成材质（`OutlineSet` 用；缺省时自己建一个） */
  material?: THREE.ShaderMaterial;
}

/** 头发用更细的一档（卡片重叠处线宽会叠加，见 `OUTLINE_HAIR_WIDTH` 的注释）。 */
export function isHairMaterialName(name: string | null | undefined): boolean {
  return Boolean(name) && /(?:^|_)hair$/i.test(name as string);
}

export function createOutlineMaterial(options: OutlineOptions = {}): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    name: 'toon-outline',
    uniforms: {
      outlineWidth: { value: options.width ?? OUTLINE_WIDTH },
      outlineDepthBias: { value: options.depthBias ?? OUTLINE_DEPTH_BIAS },
      outlineColor: { value: new THREE.Color(options.color ?? OUTLINE_COLOR) },
    },
    vertexShader: OUTLINE_VERTEX_SHADER,
    fragmentShader: OUTLINE_FRAGMENT_SHADER,
    side: THREE.BackSide,
    transparent: false,
    depthTest: true,
    depthWrite: true,
    toneMapped: false,
    // 与共面几何共存时再保险一层：多边形偏移把描边壳往后推
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    // 描边是"外壳"，不参与雾/顶点色/贴图
    fog: false,
  });
  return material;
}

export interface OutlineMeshRecord {
  source: string;
  outline: string;
  /** 共享同一几何（不复制顶点） */
  sharedGeometry: boolean;
  skinned: boolean;
}

/**
 * 给单个网格加描边（`applyOutline(mesh)`）。
 *
 * - 克隆**同一几何**（不复制顶点、不复制贴图）；
 * - `SkinnedMesh` 克隆会共享 `Skeleton`，所以跟骨动画完全同步；
 * - 返回新建的描边网格（已挂到与原网格同一个父节点下），不该描边时返回 `null`。
 */
export function applyOutline(
  mesh: THREE.Mesh,
  options: OutlineOptions = {},
): { outline: THREE.Mesh; record: OutlineMeshRecord } | null {
  if (mesh.name.endsWith('__outline')) return null;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const target = materials.find((material) => material && isOutlineMaterialName(material.name));
  if (!target) return null;
  if (!mesh.parent) return null;

  // 幂等：同一网格只挂一层描边（重复装配不会越描越黑）
  const outlineName = `${mesh.name}__outline`;
  if (mesh.parent.children.some((child) => child.name === outlineName)) return null;

  const outline = mesh.clone(false) as THREE.Mesh;
  outline.name = outlineName;
  outline.material = options.material ?? createOutlineMaterial(options);
  // 描边壳与原网格同深（而绑定姿态包围球可能偏小），关掉视锥裁剪免得整圈消失
  outline.frustumCulled = false;
  outline.castShadow = false;
  outline.receiveShadow = false;
  outline.matrixAutoUpdate = true;
  // 先压后画不保证：显式渲染顺序让描边在主网格之前，深度测试再裁决
  outline.renderOrder = mesh.renderOrder - 1;
  mesh.parent.add(outline);

  return {
    outline,
    record: {
      source: mesh.name || '(unnamed)',
      outline: outline.name,
      sharedGeometry: outline.geometry === mesh.geometry,
      skinned: (mesh as THREE.SkinnedMesh).isSkinnedMesh === true,
    },
  };
}

export interface OutlineDiagnostics {
  enabled: boolean;
  /** 身体/脸的宽度（px） */
  width: number;
  /** 头发的宽度（px）；卡片重叠会叠线，所以单独一档更细 */
  hairWidth: number;
  depthBias: number;
  color: string;
  /** 参与描边的源网格（材质名） */
  sources: string[];
  meshes: OutlineMeshRecord[];
  /**
   * 描边壳的世界矩阵是否与源网格完全一致（逐元素差 < 1e-6）。
   *
   * 这是"描边不会穿模、不会滞后"的结构性判据：两者共享几何 + 共享骨骼 +
   * 同一父节点，任何一帧渲染时它们都在同一空间里；不等就说明装配写错了。
   */
  tracked: boolean;
  /** 世界矩阵的最大元素差（诊断用；正常应为 0） */
  matrixDelta: number;
}

/**
 * 描边集合：一次装配、可整体开关（A/B 截图用）、随模型销毁。
 *
 * 与 `ToonShading` 一样是渲染内部对象，不进 `RenderState`。
 */
export class OutlineSet {
  private readonly records: OutlineMeshRecord[] = [];
  private readonly outlines: THREE.Mesh[] = [];
  private readonly sources = new Map<THREE.Mesh, THREE.Mesh>();
  private readonly materials = new Map<'body' | 'hair', THREE.ShaderMaterial>();
  private enabled = true;

  constructor(private readonly options: OutlineOptions = {}) {
    this.materials.set('body', createOutlineMaterial(options));
    this.materials.set(
      'hair',
      createOutlineMaterial({ ...options, width: options.width ?? OUTLINE_HAIR_WIDTH }),
    );
  }

  private materialFor(materialName: string | null | undefined): THREE.ShaderMaterial {
    return this.materials.get(isHairMaterialName(materialName) ? 'hair' : 'body')!;
  }

  /** 遍历 root，给所有命中材质的网格加描边。幂等（同名描边已存在就跳过）。 */
  attach(root: THREE.Object3D): number {
    const targets: THREE.Mesh[] = [];
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      if (!mesh.visible) return;
      if (mesh.name.endsWith('__outline')) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (!materials.some((material) => material && isOutlineMaterialName(material.name))) return;
      targets.push(mesh);
    });

    for (const mesh of targets) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const target = materials.find((material) => material && isOutlineMaterialName(material.name));
      const result = applyOutline(mesh, {
        ...this.options,
        material: this.materialFor(target?.name),
      });
      if (!result) continue;
      result.outline.material = this.materialFor(target?.name);
      result.outline.visible = this.enabled;
      this.outlines.push(result.outline);
      this.records.push(result.record);
      this.sources.set(result.outline, mesh);
    }
    return this.records.length;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    for (const outline of this.outlines) outline.visible = enabled;
  }

  diagnostics(): OutlineDiagnostics {
    const body = this.materials.get('body')!;
    const hair = this.materials.get('hair')!;
    let matrixDelta = 0;
    for (const [outline, source] of this.sources) {
      const a = outline.matrixWorld.elements;
      const b = source.matrixWorld.elements;
      for (let i = 0; i < 16; i += 1) {
        const diff = Math.abs(a[i]! - b[i]!);
        if (diff > matrixDelta) matrixDelta = diff;
      }
    }
    return {
      enabled: this.enabled,
      width: body.uniforms.outlineWidth!.value as number,
      hairWidth: hair.uniforms.outlineWidth!.value as number,
      depthBias: body.uniforms.outlineDepthBias!.value as number,
      color: `#${(body.uniforms.outlineColor!.value as THREE.Color).getHexString()}`,
      sources: this.records.map((record) => record.source),
      meshes: [...this.records],
      tracked: matrixDelta < 1e-6,
      matrixDelta: Math.round(matrixDelta * 1e9) / 1e9,
    };
  }

  dispose(): void {
    for (const outline of this.outlines) outline.removeFromParent();
    this.outlines.length = 0;
    this.records.length = 0;
    this.sources.clear();
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
  }
}
