// 打印眼皮骨的 translation.x 时间序列片段（只读 GLB）。用来标定眨眼方向/幅度。
const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2] ?? path.join(__dirname, '..', 'CH0335.glb');
const clipNeedle = process.argv[3] ?? 'Cafe_Idle';
const nodeNeedle = process.argv[4] ?? 'bone_eye_D_L';
const from = Number(process.argv[5] ?? 0);
const to = Number(process.argv[6] ?? 4);

const buf = fs.readFileSync(file);
let offset = 12;
let json = null;
let bin = null;
while (offset < buf.length) {
  const length = buf.readUInt32LE(offset);
  const type = buf.readUInt32LE(offset + 4);
  const chunk = buf.subarray(offset + 8, offset + 8 + length);
  if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'));
  if (type === 0x004e4942) bin = chunk;
  offset += 8 + length;
}

const nodes = json.nodes ?? [];
const accessors = json.accessors ?? [];
const views = json.bufferViews ?? [];

function readAccessor(index) {
  const acc = accessors[index];
  const view = views[acc.bufferView];
  const components = { SCALAR: 1, VEC3: 3, VEC4: 4 }[acc.type] ?? 1;
  const start = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const out = [];
  for (let i = 0; i < acc.count; i += 1) {
    const values = [];
    for (let c = 0; c < components; c += 1) {
      values.push(bin.readFloatLE(start + (i * components + c) * 4));
    }
    out.push(components === 1 ? values[0] : values);
  }
  return out;
}

const animation = (json.animations ?? []).find((item) => item.name.includes(clipNeedle));
if (!animation) {
  console.error('clip not found');
  process.exit(1);
}
const targetNode = nodes.findIndex((node) => (node.name ?? '').includes(nodeNeedle));
if (targetNode < 0) {
  console.error('node not found');
  process.exit(1);
}
for (const channel of animation.channels) {
  if (channel.target.node !== targetNode) continue;
  if (channel.target.path !== 'translation') continue;
  const sampler = animation.samplers[channel.sampler];
  const times = readAccessor(sampler.input);
  const values = readAccessor(sampler.output);
  console.log(`${clipNeedle} ${nodes[targetNode].name}.translation  (${times.length} keys)`);
  for (let i = 0; i < times.length; i += 1) {
    const t = times[i];
    if (t < from || t > to) continue;
    const [x, y, z] = values[i];
    console.log(`  t=${t.toFixed(3)}  x=${x.toFixed(6)}  y=${y.toFixed(6)}  z=${z.toFixed(6)}`);
  }
}
