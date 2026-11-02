import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { OUTLINE_COLOR, OUTLINE_DEPTH_BIAS, OUTLINE_HAIR_WIDTH, OUTLINE_WIDTH } from '../../shared/constants';
import {
  OUTLINE_FRAGMENT_SHADER,
  OUTLINE_VERTEX_SHADER,
  OutlineSet,
  applyOutline,
  createOutlineMaterial,
  isOutlineMaterialName,
} from './outline';

function skinnedMesh(materialName: string, name = 'CH0335_Body_6'): THREE.SkinnedMesh {
  const geometry = new THREE.BufferGeometry();
  const count = 4;
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(count * 3).fill(1), 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(count * 4), 4));
  const bones = [new THREE.Bone(), new THREE.Bone()];
  const skeleton = new THREE.Skeleton(bones);
  const material = new THREE.MeshBasicMaterial({ name: materialName });
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = name;
  mesh.bind(skeleton);
  return mesh;
}

test('描边目标：身体/头发/脸要，眼睛嘴/光环/配件不要', () => {
  assert.equal(isOutlineMaterialName('CH0335_Body'), true);
  assert.equal(isOutlineMaterialName('CH0335_Hair'), true);
  assert.equal(isOutlineMaterialName('CH0335_Face'), true);
  assert.equal(isOutlineMaterialName('CH0335_EyeMouth'), false);
  assert.equal(isOutlineMaterialName('CH0335_Eyebrow'), false);
  assert.equal(isOutlineMaterialName('CH0335_Halo'), false);
  assert.equal(isOutlineMaterialName('CH0335_Weapon'), false);
  assert.equal(isOutlineMaterialName('CH0335_Prop'), false);
  assert.equal(isOutlineMaterialName('CH0335_Brush_01'), false);
  // 名字里带 Face 的 EyeMouth 变体也不能描边（排除规则优先）
  assert.equal(isOutlineMaterialName('CH0335_Face_EyeMouth'), false);
  assert.equal(isOutlineMaterialName(null), false);
});

test('描边材质：背面、纯色、屏幕像素宽度、深度偏移', () => {
  const material = createOutlineMaterial();
  assert.equal(material.side, THREE.BackSide);
  assert.equal(material.transparent, false);
  assert.equal(material.depthWrite, true);
  assert.equal(material.toneMapped, false);
  assert.equal(material.uniforms.outlineWidth!.value, OUTLINE_WIDTH);
  assert.equal(material.uniforms.outlineDepthBias!.value, OUTLINE_DEPTH_BIAS);
  assert.equal((material.uniforms.outlineColor!.value as THREE.Color).getHex(), OUTLINE_COLOR);
  assert.match(material.vertexShader, /skinning_pars_vertex/);
  assert.match(material.vertexShader, /skinning_vertex/);
  assert.match(material.vertexShader, /mvPosition\.xy \+= dir \* outlineWidth/);
  assert.match(OUTLINE_FRAGMENT_SHADER, /outlineColor/);
  material.dispose();
});

test('applyOutline：共享几何 + 共享骨骼，挂在同一父节点下', () => {
  const root = new THREE.Group();
  const mesh = skinnedMesh('CH0335_Body');
  root.add(mesh);

  const result = applyOutline(mesh);
  assert.ok(result);
  const outline = result!.outline as THREE.SkinnedMesh;
  assert.equal(outline.name, 'CH0335_Body_6__outline');
  assert.equal(outline.geometry, mesh.geometry, '不复制顶点：共享同一 BufferGeometry');
  assert.equal(outline.parent, mesh.parent, '同一父节点 → 世界矩阵一致');
  assert.equal(outline.skeleton, mesh.skeleton, '共享同一 Skeleton → 跟骨骼同步');
  assert.equal(outline.bindMatrix.equals(mesh.bindMatrix), true);
  assert.equal((outline.material as THREE.ShaderMaterial).side, THREE.BackSide);
  assert.equal(outline.frustumCulled, false);
  assert.ok(outline.renderOrder < mesh.renderOrder, '描边先画，深度测试裁决');
  assert.equal(result!.record.sharedGeometry, true);
  assert.equal(result!.record.skinned, true);
});

test('applyOutline：不是目标材质 / 已是描边 / 无父节点 → 返回 null', () => {
  const root = new THREE.Group();
  const eyeMouth = skinnedMesh('CH0335_EyeMouth', 'CH0335_Body_3');
  root.add(eyeMouth);
  assert.equal(applyOutline(eyeMouth), null);

  const body = skinnedMesh('CH0335_Body');
  root.add(body);
  const first = applyOutline(body);
  assert.ok(first);
  assert.equal(applyOutline(first!.outline), null, '描边壳不再套描边');

  const orphan = skinnedMesh('CH0335_Hair');
  assert.equal(applyOutline(orphan), null, '没有父节点就无处挂');
});

test('OutlineSet：一次装配、幂等、可整体开关、诊断可读', () => {
  const root = new THREE.Group();
  const body = skinnedMesh('CH0335_Body', 'CH0335_Body_6');
  const hair = skinnedMesh('CH0335_Hair', 'CH0335_Body_5');
  const face = skinnedMesh('CH0335_Face', 'CH0335_Body_1');
  const eyeMouth = skinnedMesh('CH0335_EyeMouth', 'CH0335_Body_3');
  const halo = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ name: 'CH0335_Halo' }));
  root.add(body, hair, face, eyeMouth, halo);

  const set = new OutlineSet();
  assert.equal(set.attach(root), 3);
  assert.equal(set.attach(root), 3, '重复装配不叠加');

  const outlineMeshes = root.children.filter((child) => child.name.endsWith('__outline'));
  assert.equal(outlineMeshes.length, 3);
  // 两种材质实例：身体/脸共用一档，头发单独一档（更细），程序只编译一次
  const materials = new Set(outlineMeshes.map((child) => (child as THREE.Mesh).material));
  assert.equal(materials.size, 2);

  const diagnostics = set.diagnostics();
  assert.equal(diagnostics.enabled, true);
  assert.deepEqual([...diagnostics.sources].sort(), ['CH0335_Body_1', 'CH0335_Body_5', 'CH0335_Body_6']);
  assert.equal(diagnostics.width, OUTLINE_WIDTH);
  assert.equal(diagnostics.hairWidth, OUTLINE_HAIR_WIDTH);
  assert.ok(diagnostics.hairWidth < diagnostics.width, '头发描边应更细（卡片重叠会叠线）');
  assert.equal(diagnostics.color, `#${OUTLINE_COLOR.toString(16).padStart(6, '0')}`);

  set.setEnabled(false);
  assert.equal(set.diagnostics().enabled, false);
  assert.equal(outlineMeshes.every((child) => child.visible === false), true);
  set.setEnabled(true);
  assert.equal(outlineMeshes.every((child) => child.visible === true), true);

  set.dispose();
  assert.equal(root.children.some((child) => child.name.endsWith('__outline')), false);
});

test('描边不复制顶点：几何与包围盒仍是同一份（性能与穿模的硬约束）', () => {
  const root = new THREE.Group();
  const body = skinnedMesh('CH0335_Body');
  root.add(body);
  const result = applyOutline(body)!;
  assert.equal(result.outline.geometry.uuid, body.geometry.uuid);
  const vertexCount = result.outline.geometry.getAttribute('position').count;
  assert.equal(vertexCount, 4);
  // 顶点着色器里做外扩 → CPU 侧顶点数不变（不增加内存/上传）
  assert.equal(OUTLINE_VERTEX_SHADER.includes('transformed'), true);
});
