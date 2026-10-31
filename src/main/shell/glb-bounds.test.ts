import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_FRAME_EXCLUDE } from '../../shared/model-frame';
import { parseGlbBounds, readGlbBounds } from './glb-bounds';

/** 构造一个只含 JSON chunk 的最小 GLB（解析器不读 BIN，测试足够）。 */
function makeGlb(doc: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(doc), 'utf8');
  const padding = (4 - (json.length % 4)) % 4;
  const chunk = Buffer.concat([json, Buffer.alloc(padding, 0x20)]);
  const total = 12 + 8 + chunk.length;

  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);

  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(chunk.length, 0);
  chunkHeader.write('JSON', 4, 'ascii');

  return Buffer.concat([header, chunkHeader, chunk]);
}

function docWith(options: {
  bodyScale?: number[];
  bodyTranslation?: number[];
  weapon?: boolean;
  morphTargets?: number;
  accessorMissingBounds?: boolean;
}) {
  const nodes: unknown[] = [
    { name: 'RootNode', children: options.weapon ? [1, 2] : [1] },
    {
      name: 'CH0335_Body',
      mesh: 0,
      scale: options.bodyScale,
      translation: options.bodyTranslation,
    },
  ];
  if (options.weapon) {
    nodes.push({ name: 'CH0335_Weapon', mesh: 0, translation: [-10, 0, 0] });
  }
  const accessor = options.accessorMissingBounds
    ? { count: 8 }
    : { count: 8, min: [-1, -1, -1], max: [1, 3, 1] };
  const primitive: Record<string, unknown> = { attributes: { POSITION: 0 } };
  if (options.morphTargets) {
    primitive['targets'] = Array.from({ length: options.morphTargets }, () => ({}));
  }
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    meshes: [{ name: 'M', primitives: [primitive] }],
    accessors: [accessor],
  };
}

test('基础包围盒：节点变换参与世界 AABB', () => {
  const result = parseGlbBounds(makeGlb(docWith({})));
  assert.equal(result.ok, true);
  assert.ok(result.sceneBounds);
  assert.equal(result.sceneBounds?.minX, -1);
  assert.equal(result.sceneBounds?.maxX, 1);
  assert.equal(result.sceneBounds?.minY, -1);
  assert.equal(result.sceneBounds?.maxY, 3);
  assert.equal(result.nodeCount, 2);
});

test('节点缩放被正确应用', () => {
  const result = parseGlbBounds(makeGlb(docWith({ bodyScale: [2, 2, 2] })));
  assert.equal(result.ok, true);
  assert.equal(result.sceneBounds?.minX, -2);
  assert.equal(result.sceneBounds?.maxX, 2);
  assert.equal(result.sceneBounds?.maxY, 6);
});

test('节点平移被正确应用', () => {
  const result = parseGlbBounds(
    makeGlb(docWith({ bodyTranslation: [100, 20, 0] })),
  );
  assert.equal(result.ok, true);
  assert.equal(result.sceneBounds?.minX, 99);
  assert.equal(result.sceneBounds?.maxX, 101);
  assert.equal(result.sceneBounds?.minY, 19);
});

test('取景排除：配件进 scene、不进 frame，并被记录', () => {
  const result = parseGlbBounds(makeGlb(docWith({ weapon: true })), {
    excludePattern: DEFAULT_FRAME_EXCLUDE,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.excludedMeshes, ['CH0335_Weapon']);

  // 全场景包含武器（x 伸到 -11）
  assert.equal(result.sceneBounds?.minX, -11);
  // 取景只看角色
  assert.equal(result.frameBounds?.minX, -1);
  assert.equal(result.frameBounds?.maxX, 1);
  assert.equal(result.frameBounds?.maxY, 3);
});

test('取景全部被排除时退回全场景（不产生空包围盒）', () => {
  const result = parseGlbBounds(makeGlb(docWith({ weapon: true })), {
    excludePattern: '.*',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.frameBounds, result.sceneBounds);
});

test('morph target 探测：数量 > 0 时置位', () => {
  const withMorph = parseGlbBounds(makeGlb(docWith({ morphTargets: 3 })));
  assert.equal(withMorph.hasMorphTargets, true);

  const withoutMorph = parseGlbBounds(makeGlb(docWith({})));
  assert.equal(withoutMorph.hasMorphTargets, false);
});

test('坏输入不抛异常：magic/版本/JSON/缺包围盒', () => {
  const badMagic = Buffer.from('nope-nope-nope-nope');
  assert.equal(parseGlbBounds(badMagic).ok, false);

  const short = Buffer.alloc(8);
  assert.equal(parseGlbBounds(short).ok, false);

  const badJson = Buffer.alloc(12 + 8 + 8);
  badJson.write('glTF', 0, 'ascii');
  badJson.writeUInt32LE(2, 4);
  badJson.writeUInt32LE(badJson.length, 8);
  badJson.writeUInt32LE(8, 12);
  badJson.write('JSON', 16, 'ascii');
  badJson.write('{oops}', 20, 'utf8');
  assert.equal(parseGlbBounds(badJson).ok, false);

  const missingBounds = parseGlbBounds(makeGlb(docWith({ accessorMissingBounds: true })));
  assert.equal(missingBounds.ok, false);
  assert.match(missingBounds.error ?? '', /包围盒/);
});

test('读文件失败只返回 ok=false', () => {
  const result = readGlbBounds('D:\\__definitely_missing__\\nope.glb');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /读取失败/);
});
