/**
 * 占位胶囊体（模型缺失/解析失败时的回退，契约 §7.3、§11；ADR 0009 D6）。
 *
 * 与真实模型共用同一套"脚底锚定"约定：group 的原点就是脚底，缩放/呼吸以脚底为锚点。
 * 这里只造几何，不负责加载与状态；`render-module` 决定什么时候用它。
 */
import * as THREE from 'three';

const CAPSULE_RADIUS = 70;
const CAPSULE_BODY_LENGTH = 210;
const CAPSULE_TOTAL_HEIGHT = CAPSULE_BODY_LENGTH + CAPSULE_RADIUS * 2;
const BOTTOM_MARGIN_PX = 24;
const EYE_RADIUS = 11;

export interface PlaceholderModel {
  group: THREE.Group;
  /** 胶囊体总高（CSS px 基准，用于诊断） */
  heightPx: number;
  dispose(): void;
}

export function createCapsulePlaceholder(): PlaceholderModel {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const bodyGeometry = new THREE.CapsuleGeometry(
    CAPSULE_RADIUS,
    CAPSULE_BODY_LENGTH,
    8,
    28,
  );
  // 底边挪到本地 y = 0，缩放以"脚底"为锚点
  bodyGeometry.translate(0, CAPSULE_TOTAL_HEIGHT / 2, 0);
  const bodyMaterial = new THREE.MeshBasicMaterial({ color: 0x8fd0ff });
  const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
  group.add(body);
  geometries.push(bodyGeometry);
  materials.push(bodyMaterial);

  const eyeGeometry = new THREE.SphereGeometry(EYE_RADIUS, 16, 12);
  eyeGeometry.scale(1, 1, 0.35);
  const eyeMaterial = new THREE.MeshBasicMaterial({ color: 0x1b2b3a });
  for (const offsetX of [-26, 26]) {
    const eye = new THREE.Mesh(eyeGeometry, eyeMaterial);
    // 放在胶囊体顶部 22%（R-10 头部带）内
    eye.position.set(offsetX, CAPSULE_TOTAL_HEIGHT - 62, CAPSULE_RADIUS - 6);
    group.add(eye);
  }
  geometries.push(eyeGeometry);
  materials.push(eyeMaterial);

  group.position.y = 0; // render-module 负责把它放到内容区底边

  return {
    group,
    heightPx: CAPSULE_TOTAL_HEIGHT,
    dispose(): void {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}

/** 占位胶囊体相对内容区底边的默认留白（沿用占位实现的历史值）。 */
export const PLACEHOLDER_BOTTOM_MARGIN_PX = BOTTOM_MARGIN_PX;
