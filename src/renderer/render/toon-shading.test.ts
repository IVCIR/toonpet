import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  TOON_AMBIENT_INTENSITY,
  TOON_DIRECTIONAL_INTENSITY,
  TOON_STEPS,
  ToonShading,
  createToonGradientMap,
  gradientStepValues,
  isToonMaterialName,
} from './toon-shading';

function meshWith(name: string, materialName: string): THREE.Mesh {
  const material = new THREE.MeshBasicMaterial({ name: materialName });
  material.alphaTest = 0.5;
  material.side = THREE.DoubleSide;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  mesh.name = name;
  return mesh;
}

test('只有身体/头发材质参与 Toon，面部材质永不参与（§7.3 死守）', () => {
  assert.equal(isToonMaterialName('CH0335_Body'), true);
  assert.equal(isToonMaterialName('CH0335_Hair'), true);
  assert.equal(isToonMaterialName('CH0335_Face'), false);
  assert.equal(isToonMaterialName('CH0335_EyeMouth'), false);
  assert.equal(isToonMaterialName('CH0335_Eyebrow'), false);
  assert.equal(isToonMaterialName('CH0335_Eyebrow2'), false);
  // 名字里带 Face 的即使以 Body 结尾也不许换
  assert.equal(isToonMaterialName('CH0335_Face_Body'), false);
  assert.equal(isToonMaterialName(null), false);
  assert.equal(isToonMaterialName(''), false);
});

test('渐变贴图是 3 阶、最近邻采样、写在线性空间', () => {
  const texture = createToonGradientMap();
  assert.equal(texture.image.width, 32);
  assert.equal(texture.image.height, 1);
  assert.equal(texture.magFilter, THREE.NearestFilter);
  assert.equal(texture.minFilter, THREE.NearestFilter);
  assert.equal(texture.generateMipmaps, false);
  assert.equal(texture.colorSpace, THREE.NoColorSpace);
  assert.deepEqual(gradientStepValues(texture), [0.58, 0.8, 1]);
  texture.dispose();
});

test('色阶断点按 dot(N,L) 排：背光 0.58、过渡 0.80、受光 1.0', () => {
  const texture = createToonGradientMap(TOON_STEPS, 32);
  const data = texture.image.data as Uint8Array;
  const sample = (dotNL: number): number => {
    const u = dotNL * 0.5 + 0.5;
    const index = Math.min(31, Math.max(0, Math.floor(u * 32)));
    return Math.round((data[index * 4]! / 255) * 100) / 100;
  };
  assert.equal(sample(-1), 0.58);
  // 贴图按 texel 量化：32 格里断点落在 dotNL=0 附近（误差 < 1 texel），所以取 -0.05
  assert.equal(sample(-0.05), 0.58);
  assert.equal(sample(0.2), 0.8);
  assert.equal(sample(0.6), 1);
  assert.equal(sample(1), 1);
  texture.dispose();
});

test('材质替换只命中身体/头发，并保留贴图、alphaTest、side、颜色', () => {
  const scene = new THREE.Scene();
  const toon = new ToonShading(scene);
  const root = new THREE.Group();
  const body = meshWith('CH0335_Body_6', 'CH0335_Body');
  const hair = meshWith('CH0335_Body_5', 'CH0335_Hair');
  const face = meshWith('CH0335_Body_1', 'CH0335_Face');
  const eyeMouth = meshWith('CH0335_Body_3', 'CH0335_EyeMouth');
  const sourceBody = body.material as THREE.MeshBasicMaterial;
  const texture = new THREE.Texture();
  sourceBody.map = texture;
  sourceBody.color.setHex(0xffeecc);
  root.add(body, hair, face, eyeMouth);
  scene.add(root);

  const count = toon.attach(root);
  assert.equal(count, 2);
  for (const mesh of [body, hair]) {
    const material = mesh.material as THREE.MeshToonMaterial;
    assert.equal(material.type, 'MeshToonMaterial');
    assert.equal(material.gradientMap, toon.gradient);
    assert.equal(material.alphaTest, 0.5);
    assert.equal(material.side, THREE.DoubleSide);
    assert.equal(material.toneMapped, false);
    assert.equal(material.vertexColors, false, 'COLOR_0 只有 alpha 有数据，不能开 vertexColors');
  }
  assert.equal((body.material as THREE.MeshToonMaterial).map, texture);
  assert.equal((body.material as THREE.MeshToonMaterial).color.getHex(), 0xffeecc);
  // 面部保持原样
  assert.equal((face.material as THREE.Material).type, 'MeshBasicMaterial');
  assert.equal((eyeMouth.material as THREE.Material).type, 'MeshBasicMaterial');

  const diagnostics = toon.diagnostics();
  assert.deepEqual(diagnostics.litMeshes.sort(), ['CH0335_Body_5', 'CH0335_Body_6']);
  assert.deepEqual(diagnostics.gradientSteps, [0.58, 0.8, 1]);
  assert.equal(diagnostics.materials.length, 2);
  toon.dispose();
});

test('A/B 开关：关 = 摘灯 + 还原无光照材质，开 = 恢复 Toon', () => {
  const scene = new THREE.Scene();
  const toon = new ToonShading(scene);
  const root = new THREE.Group();
  const body = meshWith('CH0335_Body_6', 'CH0335_Body');
  const original = body.material;
  root.add(body);
  scene.add(root);
  toon.attach(root);

  assert.equal(scene.children.includes(toon.ambient), true);
  assert.equal(scene.children.includes(toon.directional), true);

  toon.setEnabled(false);
  assert.equal(toon.isEnabled, false);
  assert.equal(scene.children.includes(toon.ambient), false);
  assert.equal(scene.children.includes(toon.directional), false);
  assert.equal(body.material, original, '关闭后必须回到原始 Basic 材质');

  toon.setEnabled(true);
  assert.equal((body.material as THREE.Material).type, 'MeshToonMaterial');
  assert.equal(scene.children.includes(toon.ambient), true);
  toon.dispose();
});

test('光照参数：主方向光在斜上方、环境光极低，且亮度配平到"受光 = 贴图原色"', () => {
  const scene = new THREE.Scene();
  const toon = new ToonShading(scene);
  assert.equal(toon.ambient.intensity, TOON_AMBIENT_INTENSITY);
  assert.equal(toon.directional.intensity, TOON_DIRECTIONAL_INTENSITY);
  assert.ok(toon.directional.position.y > 0, '方向光应在角色上方');
  assert.ok(toon.directional.position.x < 0, '方向光应在角色左上方');
  assert.ok(toon.directional.position.z > 0, '方向光应在前方（+Z = 面向镜头）');
  // three 的 toon BRDF 是 (ambient + gradient*directional)/π；满档应等于 1
  const lit = (TOON_AMBIENT_INTENSITY + TOON_DIRECTIONAL_INTENSITY) / Math.PI;
  assert.ok(Math.abs(lit - 1) < 0.02, `受光面亮度应≈1，实际 ${lit.toFixed(3)}`);
  assert.ok(TOON_AMBIENT_INTENSITY / (TOON_AMBIENT_INTENSITY + TOON_DIRECTIONAL_INTENSITY) < 0.25);
  toon.dispose();
});

