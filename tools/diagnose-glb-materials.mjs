/**
 * 只读诊断脚本：解析 GLB 的 JSON chunk，输出网格 / 材质 / 贴图 / UV 集合事实。
 * 不引入 three、不联网、不修改任何文件；仅用于"手部发白"定位（阶段 14 视觉问题）。
 *
 * 用法：node tools/diagnose-glb-materials.mjs [pathToGlb]
 */
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const path = resolve(process.argv[2] ?? 'CH0335.glb');
const buf = readFileSync(path);

if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB（magic 不匹配）');
const version = buf.readUInt32LE(4);
const total = buf.readUInt32LE(8);

let offset = 12;
let json = null;
const chunks = [];
while (offset + 8 <= buf.length) {
  const len = buf.readUInt32LE(offset);
  const type = buf.readUInt32LE(offset + 4);
  const data = buf.subarray(offset + 8, offset + 8 + len);
  chunks.push({ type: type === 0x4e4f534a ? 'JSON' : type === 0x004e4942 ? 'BIN' : `0x${type.toString(16)}`, len });
  if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8').replace(/\0+$/, '').trim());
  offset += 8 + len;
}

const g = json;
console.log(`# GLB: ${basename(path)}  v${version}  ${total} bytes  chunks=${JSON.stringify(chunks)}`);
console.log(`asset: ${JSON.stringify(g.asset)}`);
console.log(`extensionsUsed: ${JSON.stringify(g.extensionsUsed ?? [])}`);
console.log(`counts: scenes=${g.scenes?.length ?? 0} nodes=${g.nodes?.length ?? 0} meshes=${g.meshes?.length ?? 0} materials=${g.materials?.length ?? 0} textures=${g.textures?.length ?? 0} images=${g.images?.length ?? 0} skins=${g.skins?.length ?? 0} animations=${g.animations?.length ?? 0}`);

console.log('\n## images');
(g.images ?? []).forEach((img, i) => {
  const embedded = img.bufferView !== undefined;
  const uri = img.uri ?? null;
  console.log(`  [${i}] name=${JSON.stringify(img.name ?? '')} mime=${img.mimeType ?? '-'} embedded=${embedded} uri=${uri ? JSON.stringify(uri) : 'null'} bufferView=${img.bufferView ?? '-'}`);
});

console.log('\n## textures');
(g.textures ?? []).forEach((t, i) => {
  console.log(`  [${i}] name=${JSON.stringify(t.name ?? '')} source=${t.source ?? '-'} sampler=${t.sampler ?? '-'} extensions=${JSON.stringify(t.extensions ?? {})}`);
});

const texName = (idx) => {
  if (idx === undefined || idx === null) return 'null';
  const t = g.textures?.[idx];
  if (!t) return `#${idx}(missing)`;
  const img = t.source !== undefined ? g.images?.[t.source] : undefined;
  return `#${idx}:${JSON.stringify(t.name ?? img?.name ?? '')}->${img ? (img.uri ? 'EXTERNAL:' + img.uri : 'embedded') : 'no-image'}`;
};

console.log('\n## materials');
(g.materials ?? []).forEach((m, i) => {
  const pbr = m.pbrMetallicRoughness ?? {};
  const bct = pbr.baseColorTexture;
  console.log(`  [${i}] name=${JSON.stringify(m.name ?? '')}`);
  console.log(`      baseColorFactor=${JSON.stringify(pbr.baseColorFactor ?? 'default[1,1,1,1]')} metallic=${pbr.metallicFactor ?? 1} roughness=${pbr.roughnessFactor ?? 1}`);
  console.log(`      baseColorTexture=${bct ? texName(bct.index) + ' texCoord=' + (bct.texCoord ?? 0) : 'null'}`);
  console.log(`      emissiveFactor=${JSON.stringify(m.emissiveFactor ?? [0, 0, 0])} emissiveTexture=${m.emissiveTexture ? texName(m.emissiveTexture.index) : 'null'}`);
  console.log(`      alphaMode=${m.alphaMode ?? 'OPAQUE'} alphaCutoff=${m.alphaCutoff ?? '-'} doubleSided=${m.doubleSided ?? false} unlit=${JSON.stringify(m.extensions?.KHR_materials_unlit ?? null)}`);
  if (m.extras) console.log(`      extras=${JSON.stringify(m.extras)}`);
});

// 节点：找 mesh + skin
const nodeName = (i) => g.nodes?.[i]?.name ?? `#${i}`;
const meshNodes = [];
(g.nodes ?? []).forEach((n, i) => {
  if (n.mesh !== undefined) meshNodes.push({ i, name: n.name ?? '', mesh: n.mesh, skin: n.skin });
});
console.log('\n## mesh nodes (name -> mesh, skin)');
for (const n of meshNodes) {
  const mesh = g.meshes[n.mesh];
  console.log(`  node[${n.i}] ${JSON.stringify(nodeName(n.i))} -> mesh[${n.mesh}] ${JSON.stringify(mesh?.name ?? '')} skin=${n.skin ?? '-'}`);
}

console.log('\n## meshes / primitives');
(g.meshes ?? []).forEach((mesh, mi) => {
  console.log(`  mesh[${mi}] name=${JSON.stringify(mesh.name ?? '')} primitives=${mesh.primitives.length}`);
  mesh.primitives.forEach((p, pi) => {
    const attrs = Object.keys(p.attributes ?? {}).join(',');
    const mat = g.materials?.[p.material];
    console.log(`    prim[${pi}] material=${p.material ?? 'none'}(${JSON.stringify(mat?.name ?? '')}) mode=${p.mode ?? 4} attrs=[${attrs}] indices=${p.indices ?? '-'}`);
  });
});

// 材质 -> 使用它的 mesh/primitive 反查
const byMaterial = new Map();
(g.meshes ?? []).forEach((mesh, mi) => {
  mesh.primitives.forEach((p, pi) => {
    if (p.material === undefined) return;
    if (!byMaterial.has(p.material)) byMaterial.set(p.material, []);
    byMaterial.get(p.material).push(`${mesh.name || 'mesh' + mi}[${pi}]`);
  });
});
console.log('\n## material -> used by');
for (const [mi, users] of [...byMaterial.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  material[${mi}] ${JSON.stringify(g.materials?.[mi]?.name ?? '')} <- ${users.join(', ')}`);
}

// 每个 primitive 的 POSITION 包围盒（判断手部位置）+ UV 范围
const accessorMinMax = (idx) => {
  const a = g.accessors?.[idx];
  if (!a) return null;
  return { min: a.min, max: a.max, count: a.count, componentType: a.componentType, type: a.type };
};
console.log('\n## primitive POSITION bounds (bind pose, model units)');
(g.meshes ?? []).forEach((mesh, mi) => {
  mesh.primitives.forEach((p, pi) => {
    const pos = accessorMinMax(p.attributes?.POSITION);
    const uv = accessorMinMax(p.attributes?.TEXCOORD_0);
    console.log(`  ${mesh.name || 'mesh' + mi}[${pi}] material=${JSON.stringify(g.materials?.[p.material]?.name ?? '')}`);
    console.log(`      POSITION count=${pos?.count} min=${JSON.stringify(pos?.min)} max=${JSON.stringify(pos?.max)}`);
    console.log(`      TEXCOORD_0 count=${uv?.count} min=${JSON.stringify(uv?.min)} max=${JSON.stringify(uv?.max)}`);
    console.log(`      COLOR_0=${p.attributes?.COLOR_0 !== undefined ? 'yes' : 'no'} JOINTS_0=${p.attributes?.JOINTS_0 !== undefined ? 'yes' : 'no'} WEIGHTS_0=${p.attributes?.WEIGHTS_0 !== undefined ? 'yes' : 'no'}`);
  });
});

console.log('\n## skins/joints of interest');
(g.skins ?? []).forEach((s, si) => {
  const joints = (s.joints ?? []).map((j) => nodeName(j));
  const wanted = joints.filter((n) => /hand|arm|clavicle|spine/i.test(n));
  console.log(`  skin[${si}] joints=${joints.length} wanted=[${wanted.join(', ')}]`);
});
