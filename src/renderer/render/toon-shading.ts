/**
 * 全局光照 + Toon 材质（身体/头发专用，ADR 0037）。
 *
 * 背景：本资产由 `model-loader` 统一转成无光照 `MeshBasicMaterial`（场景里没有任何灯），
 * 于是"身体/衣服"完全是平涂——贴图是平涂色块，材质又不错做任何明暗。ADR 0036 当时
 * 只手/小臂用顶点色烘焙了一层假明暗；本轮改为**真光照**：
 *
 *   1. 一盏主方向光（斜上方偏左前，`+Z` 是角色正面）+ 一盏极低强度环境光；
 *   2. 只把 `CH0335_Body`（身体/衣服）与 `CH0335_Hair`（头发）换成 `MeshToonMaterial`；
 *   3. 用代码生成 **3 阶** 渐变贴图（`gradientMap`），`NearestFilter` → 硬边缘二次元二分阴影；
 *   4. 面部（`Face` / `EyeMouth` / 眉毛）**永远不参与**本模块，保持无光照（ADR 0037 D3）。
 *
 * 为什么是 `gradientMap` 而不是自己写 shader：three 的 `MeshToonMaterial` 已经实现了
 * `dot(N, L)` 的查找表着色（`getGradientIrradiance`），贴图里放什么颜色就出什么色阶，
 * 不新增依赖、不新增 render pass、每帧成本与 Lambert 同级。
 *
 * 亮度配平（为什么是 0.55 / 2.6）：three 的 toon BRDF 是
 * `outgoing = map * (ambient + gradient * directional) / π`。取
 * `ambient + directional = π` 时，光照最亮处正好等于贴图原色（白色外套仍是官方白，
 * 不会被整体压灰），而环境光只占其中的 17.5% —— 即"极低强度"。
 */
import * as THREE from 'three';

/** 一级色阶：`maxDot` 是 `dot(N, L)` 的上界（-1..1），`value` 是该段的亮度乘子。 */
export interface ToonStep {
  maxDot: number;
  value: number;
}

/**
 * 默认 3 阶色阶（暗 / 中 / 亮）。断点按 `dot(N, L)` 排：
 * - `dot ≤ 0.12`：背光面，0.58（明显但不成灰块）
 * - `0.12 < dot ≤ 0.38`：过渡侧，0.80
 * - `dot > 0.38`：受光面，1.00（= 贴图原色）
 *
 * 断点为什么偏正：本资产是 Q 版模型，正对镜头的面（外套、裙面）法线几乎都是 +Z，
 * 与"左上前"的光夹角余弦 ≈ 0.58，落在受光档；转过去的手臂/发梢才会掉进中/暗档，
 * 所以"二分线"天然出现在圆柱体的侧缘 —— 这正是官方 NPR 的观感。
 */
export const TOON_STEPS: readonly ToonStep[] = [
  { maxDot: 0.12, value: 0.58 },
  { maxDot: 0.38, value: 0.8 },
  { maxDot: 1, value: 1 },
];

/** 环境光强度（three 的物理光照口径：`ambient / π` 才是"乘在颜色上的比例"）。 */
export const TOON_AMBIENT_INTENSITY = 0.55;
/** 主方向光强度；与 ambient 相加 ≈ π，保证受光面 = 贴图原色。 */
export const TOON_DIRECTIONAL_INTENSITY = 2.6;
/** 指向光源的方向（模型空间：+Y 向上、+Z 朝向镜头、+X 画面右侧）= 斜上方偏左前。 */
export const TOON_LIGHT_DIRECTION: readonly [number, number, number] = [-0.38, 0.72, 0.58];

/**
 * 参与 Toon 的材质名：`*_Body`（身体/衣服）与 `*_Hair`（头发）。
 * 其余材质（Face / EyeMouth / Eyebrow / Weapon / Prop / brush / Halo）一律不动。
 */
export const TOON_MATERIAL_PATTERN = /^(?:.*_)?(?:Body|Hair)$/i;
/** 面部材质：即使名字里带了 Body/Hair 也永不参与 Toon（ADR 0037 D3）。 */
export const FACE_MATERIAL_PATTERN = /face|eyemouth|eyebrow/i;

/** 这个材质名该不该换成 Toon。 */
export function isToonMaterialName(name: string | null | undefined): boolean {
  if (!name) return false;
  if (FACE_MATERIAL_PATTERN.test(name)) return false;
  return TOON_MATERIAL_PATTERN.test(name);
}

/** 3 阶（或任意阶）色阶贴图：宽 32、`NearestFilter`，灰度写进 RGB（shader 取 `.r`）。 */
export function createToonGradientMap(
  steps: readonly ToonStep[] = TOON_STEPS,
  width = 32,
): THREE.DataTexture {
  const safeWidth = Math.max(2, Math.floor(width));
  const data = new Uint8Array(safeWidth * 4);
  const last = steps[steps.length - 1]?.value ?? 1;
  for (let i = 0; i < safeWidth; i += 1) {
    // three 的 toon 查找坐标是 `dotNL * 0.5 + 0.5`，这里反推回 dotNL 再查段
    const dotNL = ((i + 0.5) / safeWidth) * 2 - 1;
    let value = last;
    for (const step of steps) {
      if (dotNL <= step.maxDot) {
        value = step.value;
        break;
      }
    }
    const byte = Math.round(Math.min(1, Math.max(0, value)) * 255);
    data[i * 4] = byte;
    data[i * 4 + 1] = byte;
    data[i * 4 + 2] = byte;
    data[i * 4 + 3] = 255;
  }

  const texture = new THREE.DataTexture(data, safeWidth, 1, THREE.RGBAFormat);
  texture.name = `toon-gradient-${steps.length}step`;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  // 色阶是"亮度乘子"，不是颜色：必须留在线性空间，不能被 sRGB 解码
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** 渐变贴图里实际出现的色阶值（去重升序，诊断用）。 */
export function gradientStepValues(texture: THREE.DataTexture): number[] {
  const array = texture.image.data as Uint8Array;
  const values = new Set<number>();
  for (let i = 0; i < array.length; i += 4) values.add(Math.round((array[i]! / 255) * 1000) / 1000);
  return [...values].sort((a, b) => a - b);
}

export interface ToonMaterialSwap {
  mesh: string;
  material: string;
  from: string;
  to: string;
}

export interface ToonShadingDiagnostics {
  enabled: boolean;
  ambient: number;
  directional: number;
  direction: [number, number, number];
  /** 色阶值（暗 → 亮） */
  gradientSteps: number[];
  /** 渐变贴图的像素宽（阶数越少越硬） */
  gradientWidth: number;
  materials: ToonMaterialSwap[];
  litMeshes: string[];
}

export interface ToonShadingOptions {
  ambientIntensity?: number;
  directionalIntensity?: number;
  direction?: readonly [number, number, number];
  steps?: readonly ToonStep[];
}

interface MeshBinding {
  mesh: THREE.Mesh;
  original: THREE.Material | THREE.Material[];
  toon: THREE.Material | THREE.Material[];
}

/**
 * 光照 + 材质替换的持有者。
 *
 * - `attach(root)`：模型加载后调用一次，换材质并记录原始材质（供诊断 A/B 还原）；
 * - `setEnabled(false)`：摘掉灯、还原原始材质 = **修改前**的样子（截图对照用）；
 * - `diagnostics()`：给 `RenderDiagnostics.toon`（内部诊断，不进 `RenderState`）。
 */
export class ToonShading {
  readonly ambient: THREE.AmbientLight;
  readonly directional: THREE.DirectionalLight;
  readonly gradient: THREE.DataTexture;
  readonly steps: readonly ToonStep[];
  private readonly scene: THREE.Scene;
  private readonly bindings: MeshBinding[] = [];
  private readonly swaps: ToonMaterialSwap[] = [];
  private enabled = true;

  constructor(scene: THREE.Scene, options: ToonShadingOptions = {}) {
    this.scene = scene;
    this.steps = options.steps ?? TOON_STEPS;

    const direction = new THREE.Vector3(...(options.direction ?? TOON_LIGHT_DIRECTION)).normalize();
    this.ambient = new THREE.AmbientLight(0xffffff, options.ambientIntensity ?? TOON_AMBIENT_INTENSITY);
    this.ambient.name = 'toon-ambient';
    this.directional = new THREE.DirectionalLight(
      0xffffff,
      options.directionalIntensity ?? TOON_DIRECTIONAL_INTENSITY,
    );
    this.directional.name = 'toon-directional';
    // 方向光只认"位置 - target"；target 默认在原点且已在场景内，所以位置即方向
    this.directional.position.copy(direction.clone().multiplyScalar(10));
    this.directional.target.position.set(0, 0, 0);
    scene.add(this.ambient, this.directional);
    scene.add(this.directional.target);

    this.gradient = createToonGradientMap(this.steps);
  }

  /** 遍历 root，把命中 `isToonMaterialName` 的材质换成 `MeshToonMaterial`。可重复调用（幂等）。 */
  attach(root: THREE.Object3D): number {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (this.bindings.some((binding) => binding.mesh === mesh)) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (!materials.some((material) => material && isToonMaterialName(material.name))) return;

      const original = Array.isArray(mesh.material) ? [...mesh.material] : mesh.material;
      const convert = (material: THREE.Material | undefined | null): THREE.Material => {
        if (!material) return material as unknown as THREE.Material;
        if (!isToonMaterialName(material.name)) return material;
        const source = material as THREE.MeshBasicMaterial;
        const toon = new THREE.MeshToonMaterial({
          name: material.name,
          // 贴图色彩空间沿用 GLTFLoader 的设置（baseColor = sRGB），不能重建
          map: source.map ?? null,
          color: source.color ? source.color.clone() : new THREE.Color(0xffffff),
          // 本资产的 COLOR_0 只有 alpha 在变（0 / 0.5 / 1，实测见 ADR 0037 资产审查），
          // RGB 恒为 1；一旦开启 vertexColors，alpha 会被乘进 diffuse.a —— 未来若给
          // 头发开 alphaTest，就会把一半发丝裁掉。这里显式关掉，只用贴图颜色。
          vertexColors: false,
          transparent: false,
          alphaTest: source.alphaTest ?? 0,
          side: source.side,
          depthWrite: source.depthWrite ?? true,
          gradientMap: this.gradient,
          toneMapped: false,
        });
        this.swaps.push({
          mesh: mesh.name || '(unnamed)',
          material: material.name,
          from: material.type,
          to: toon.type,
        });
        return toon;
      };

      const toon = Array.isArray(original) ? original.map(convert) : convert(original);
      this.bindings.push({ mesh, original, toon });
      mesh.material = toon;
      // 旧材质由 model-loader 的 dispose 句柄持有，这里不 dispose（A/B 还原还要用）
    });
    return this.swaps.length;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** 诊断/截图 A/B：false = 摘灯 + 还原原始无光照材质。 */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.scene.add(this.ambient, this.directional);
      this.scene.add(this.directional.target);
    } else {
      this.scene.remove(this.ambient, this.directional);
      this.scene.remove(this.directional.target);
    }
    for (const binding of this.bindings) {
      binding.mesh.material = enabled
        ? Array.isArray(binding.toon)
          ? [...binding.toon]
          : binding.toon
        : Array.isArray(binding.original)
          ? [...binding.original]
          : binding.original;
    }
  }

  get litMeshes(): string[] {
    return [...new Set(this.swaps.map((swap) => swap.mesh))];
  }

  diagnostics(): ToonShadingDiagnostics {
    return {
      enabled: this.enabled,
      ambient: this.ambient.intensity,
      directional: this.directional.intensity,
      direction: [
        Number(this.directional.position.x.toFixed(4)),
        Number(this.directional.position.y.toFixed(4)),
        Number(this.directional.position.z.toFixed(4)),
      ],
      gradientSteps: gradientStepValues(this.gradient),
      gradientWidth: (this.gradient.image as { width: number }).width,
      materials: [...this.swaps],
      litMeshes: this.litMeshes,
    };
  }

  dispose(): void {
    this.scene.remove(this.ambient, this.directional, this.directional.target);
    this.ambient.dispose();
    this.directional.dispose();
    this.gradient.dispose();
    this.bindings.length = 0;
  }
}
