import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  DEFAULT_SKIN_SHADING,
  bakeSkinShading,
  computeSkinShade,
} from './skin-shading';

/**
 * 构造一个最小的两根骨 SkinnedMesh：
 * 顶点 0/1 由 `Bip001_L_Hand` 主导，顶点 2 由 `Bip001_Spine` 主导。
 * 这样可以在不加载 15MB GLB 的前提下验证"只染手、不动别的部位"。
 */
function createMesh(options: {
  interleavedColor?: boolean;
  colorItemSize?: number;
} = {}): THREE.SkinnedMesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
  );
  geometry.setAttribute(
    'normal',
    new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3),
  );
  geometry.setAttribute(
    'skinIndex',
    new THREE.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1], 4),
  );
  geometry.setAttribute(
    'skinWeight',
    new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4),
  );
  const itemSize = options.colorItemSize ?? 4;
  if (options.interleavedColor) {
    const data = new THREE.InterleavedBuffer(new Float32Array(3 * itemSize).fill(1), itemSize);
    geometry.setAttribute('color', new THREE.InterleavedBufferAttribute(data, itemSize, 0));
  } else {
    geometry.setAttribute(
      'color',
      new THREE.Float32BufferAttribute(new Float32Array(3 * itemSize).fill(1), itemSize),
    );
  }

  const hand = new THREE.Bone();
  hand.name = 'Bip001_L_Hand';
  const spine = new THREE.Bone();
  spine.name = 'Bip001_Spine';
  const mesh = new THREE.SkinnedMesh(
    geometry,
    new THREE.MeshBasicMaterial({ vertexColors: true }),
  );
  mesh.add(hand, spine);
  mesh.bind(new THREE.Skeleton([hand, spine]));
  return mesh;
}

test('手部烘焙：只写手部顶点，非手部保持 1（衣服/脸不受影响）', () => {
  const mesh = createMesh();
  const root = new THREE.Group();
  root.add(mesh);
  const stats = bakeSkinShading(root);

  assert.equal(stats.meshes, 1);
  assert.equal(stats.vertices, 2);
  assert.ok(stats.minShade >= DEFAULT_SKIN_SHADING.ambient - 1e-9);
  assert.ok(stats.maxShade <= 1 + 1e-9);

  const color = mesh.geometry.getAttribute('color');
  // 手部：暖肤色（r > g > b），且不是纯白
  for (const i of [0, 1]) {
    const r = color.getX(i);
    const g = color.getY(i);
    const b = color.getZ(i);
    assert.ok(r < 0.999, `hand vertex ${i} 仍是白色（r=${r}）`);
    assert.ok(r > g && g > b, `hand vertex ${i} 不是暖色（${r},${g},${b}）`);
  }
  // 非手部：保持原始白
  assert.deepEqual([color.getX(2), color.getY(2), color.getZ(2)], [1, 1, 1]);
});

test('手部烘焙：InterleavedBufferAttribute 会被转成可写的独立 BufferAttribute', () => {
  const mesh = createMesh({ interleavedColor: true });
  assert.ok(
    mesh.geometry.getAttribute('color') instanceof THREE.InterleavedBufferAttribute,
    '前置条件：构造的是交错属性',
  );
  const root = new THREE.Group();
  root.add(mesh);
  bakeSkinShading(root);
  const color = mesh.geometry.getAttribute('color');
  assert.ok(color instanceof THREE.BufferAttribute, '烘焙后必须是 BufferAttribute');
  assert.ok(color.getX(0) < 0.999);
  assert.equal(color.getX(2), 1);
});

test('手部烘焙：归一化 Uint8 顶点色会先换算成 Float32，不会把 0.83 截断成 0', () => {
  const mesh = createMesh();
  mesh.geometry.setAttribute(
    'color',
    new THREE.Uint8BufferAttribute(new Uint8Array(3 * 4).fill(255), 4, true),
  );
  const root = new THREE.Group();
  root.add(mesh);
  bakeSkinShading(root);
  const color = mesh.geometry.getAttribute('color');
  assert.ok(color.array instanceof Float32Array, '必须换成 Float32 存储');
  const r = color.getX(0);
  assert.ok(r > 0.7 && r < 0.999, `手部红色分量应约为 0.83，实际 ${r}`);
  assert.equal(color.getX(2), 1);
});

test('手部烘焙：幂等（重复调用不会越来越暗）', () => {
  const mesh = createMesh();
  const root = new THREE.Group();
  root.add(mesh);
  bakeSkinShading(root);
  const first = (mesh.geometry.getAttribute('color') as THREE.BufferAttribute).array.slice();
  bakeSkinShading(root);
  const second = (mesh.geometry.getAttribute('color') as THREE.BufferAttribute).array;
  assert.deepEqual(Array.from(second), Array.from(first));
});

test('明暗公式：朝向光最亮、背光取环境项、结果恒在 [0,1]', () => {
  const options = {
    ambient: 0.7,
    diffuse: 0.3,
    light: [0, 0, 1] as [number, number, number],
    tint: [1, 1, 1] as [number, number, number],
  };
  assert.ok(Math.abs(computeSkinShade(0, 0, 1, options) - 1) < 1e-9);
  assert.ok(Math.abs(computeSkinShade(0, 0, -1, options) - 0.7) < 1e-9);
  for (const n of [Number.NaN, 2, -2, 0]) {
    const shade = computeSkinShade(n, n, n, options);
    assert.ok(Number.isFinite(shade));
    assert.ok(shade >= 0 && shade <= 1);
  }
});

test('手部烘焙：没有 skinIndex/weight 的普通 Mesh 不会被误伤', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute([1, 1, 1], 3));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true }));
  const root = new THREE.Group();
  root.add(mesh);
  const stats = bakeSkinShading(root);
  assert.deepEqual(stats, { meshes: 0, vertices: 0, minShade: 1, maxShade: 1, meanColor: [0, 0, 0] });
});
