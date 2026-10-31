/**
 * 面部几何提取（ADR 0026 D2.2）。
 *
 * 为什么需要它：本资产的眼睛/嘴/红晕都只能靠改贴图，而"在脸上画"必须知道
 * **每个贴图像素对应脸上哪一点**。这一步在加载后一次性把每个材质组的三角形
 * 抽成 `{ 面空间顶点位置, UV }`，交给 `facial-texture` 去栅格化成"面空间表面"。
 *
 * 约定：
 * - 三角形顶点位置取**网格局部坐标**（GLB 原始 POSITION，绑定姿态）；
 * - 同一材质的三角形只取一个网格（本资产 6 个 primitive 同属 `CH0335_Body`），
 *   因此彼此的相对位置是自洽的；
 * - 本函数是纯数据搬运，不做任何绘制；缺材质/缺 UV 时返回空数组，由调用方降级。
 */
import * as THREE from 'three';
import type { LoadedModel } from './model-loader';
import type { UvTriangle } from './facial-texture';

/** 一个材质的目标：材质 + 原贴图 + 该材质组的三角形。 */
export interface FacialGeometryTarget {
  material: THREE.MeshBasicMaterial;
  sourceTexture: THREE.Texture;
  triangles: UvTriangle[];
  /** 提取到的网格名（诊断用） */
  meshName: string;
}

export interface FacialGeometry {
  /** EyeMouth：眼睛 + 嘴部底板（同一张贴图） */
  mouth: FacialGeometryTarget | null;
  /** Face：脸皮（红晕层） */
  face: FacialGeometryTarget | null;
}

/** 几何体里的一段索引范围（等价于 `geometry.groups[i]`，只取用到的字段）。 */
export interface GeometryRange {
  start: number;
  count: number;
  materialIndex?: number;
}

/** 材质名判定：EyeMouth / Face（与 model-loader 的正则保持一致）。 */
function isMouthMaterialName(name: string): boolean {
  return /EyeMouth/i.test(name);
}

function isFaceMaterialName(name: string): boolean {
  return /(^|_)Face$/i.test(name);
}

/**
 * 把一个几何体里某个材质组的三角形抽出来。
 *
 * three 的 GLTFLoader 对多 primitive 网格会产出"一个 BufferGeometry + groups +
 * 材质数组"，所以要按 `group.materialIndex` 切片；没有 groups 时按整块处理。
 */
export function extractUvTriangles(geometry: THREE.BufferGeometry, group: GeometryRange | null): UvTriangle[] {
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  if (!position || !uv) return [];

  const index = geometry.getIndex();
  const start = group ? group.start : 0;
  const count = group ? group.count : index ? index.count : position.count;
  const triangles: UvTriangle[] = [];

  const vertexAt = (offset: number): number => (index ? index.getX(offset) : offset);

  for (let offset = start; offset + 2 < start + count; offset += 3) {
    const ia = vertexAt(offset);
    const ib = vertexAt(offset + 1);
    const ic = vertexAt(offset + 2);
    if (ia === undefined || ib === undefined || ic === undefined) continue;
    triangles.push({
      ax: position.getX(ia),
      ay: position.getY(ia),
      au: uv.getX(ia),
      av: uv.getY(ia),
      bx: position.getX(ib),
      by: position.getY(ib),
      bu: uv.getX(ib),
      bv: uv.getY(ib),
      cx: position.getX(ic),
      cy: position.getY(ic),
      cu: uv.getX(ic),
      cv: uv.getY(ic),
    });
  }
  return triangles;
}

/**
 * 从已加载模型里收集面部几何（一次性，加载后调用）。
 *
 * 非 `THREE.Group` 的组（three 的类型里 `geometry.groups` 是普通对象）也支持：
 * 这里只读 `start/count/materialIndex` 三个字段。
 */
export function collectFacialGeometry(model: LoadedModel): FacialGeometry {
  const result: FacialGeometry = { mouth: null, face: null };

  for (const mesh of model.meshes) {
    const geometry = mesh.geometry;
    if (!geometry) continue;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = geometry.groups.length > 0 ? geometry.groups : null;

    const assign = (
      material: THREE.Material | undefined,
      group: GeometryRange | null,
    ): void => {
      const basic = material as THREE.MeshBasicMaterial | undefined;
      if (!basic || !basic.map) return;
      const name = basic.name ?? '';
      const triangles = extractUvTriangles(geometry, group);
      if (triangles.length === 0) return;

      if (isMouthMaterialName(name) && !result.mouth) {
        result.mouth = {
          material: basic,
          sourceTexture: basic.map,
          triangles,
          meshName: mesh.name,
        };
        return;
      }
      if (isFaceMaterialName(name) && !result.face) {
        result.face = {
          material: basic,
          sourceTexture: basic.map,
          triangles,
          meshName: mesh.name,
        };
      }
    };

    if (groups) {
      for (const group of groups) {
        assign(materials[group.materialIndex ?? 0], group);
      }
    } else {
      assign(materials[0], null);
    }
  }

  return result;
}
