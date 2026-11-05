// 计算眼皮骨在"睁眼（t=2.375）/闭眼（t=2.542）"两帧之间的四元数夹角（只读 GLB）。
// 用来判断：眨眼到底靠平移、还是靠旋转（ADR 0044 的幅度需要哪个通道）。
const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2] ?? path.join(__dirname, '..', 'CH0335.glb');
const clipNeedle = process.argv[3] ?? 'Cafe_Idle';
const tOpen = Number(process.argv[4] ?? 2.375);
const tClose = Number(process.argv[5] ?? 2.542);

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

function read(index) {
  const acc = accessors[index];
  const view = views[acc.bufferView];
  const components = { SCALAR: 1, VEC3: 3, VEC4: 4 }[acc.type] ?? 1;
  const start = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const out = [];
  for (let i = 0; i < acc.count; i += 1) {
    const values = [];
    for (let c = 0; c < components; c += 1) values.push(bin.readFloatLE(start + (i * components + c) * 4));
    out.push(components === 1 ? values[0] : values);
  }
  return out;
}

function sampleAt(times, values, t) {
  let best = 0;
  for (let i = 0; i < times.length; i += 1) {
    if (Math.abs(times[i] - t) < Math.abs(times[best] - t)) best = i;
  }
  return { t: times[best], value: values[best] };
}

function angleBetween(a, b) {
  let dot = 0;
  for (let i = 0; i < 4; i += 1) dot += a[i] * b[i];
  return 2 * Math.acos(Math.min(1, Math.abs(dot)));
}

const animation = (json.animations ?? []).find((item) => item.name.includes(clipNeedle));
for (const nodeName of ['bone_eye_D_L', 'bone_eye_D_L_01', 'bone_eye_D_L_02', 'eye_L']) {
  const nodeIndex = nodes.findIndex((n) => (n.name ?? '').endsWith(nodeName));
  if (nodeIndex < 0) continue;
  for (const channel of animation.channels) {
    if (channel.target.node !== nodeIndex) continue;
    if (channel.target.path !== 'rotation') continue;
    const sampler = animation.samplers[channel.sampler];
    const times = read(sampler.input);
    const values = read(sampler.output);
    const open = sampleAt(times, values, tOpen);
    const close = sampleAt(times, values, tClose);
    console.log(
      `${nodes[nodeIndex].name}.rotation  ` +
        `open(t=${open.t.toFixed(3)}) ∠ close(t=${close.t.toFixed(3)}) = ${angleBetween(open.value, close.value).toFixed(4)} rad`,
    );
  }
  for (const channel of animation.channels) {
    if (channel.target.node !== nodeIndex) continue;
    if (channel.target.path !== 'translation') continue;
    const sampler = animation.samplers[channel.sampler];
    const times = read(sampler.input);
    const values = read(sampler.output);
    const open = sampleAt(times, values, tOpen);
    const close = sampleAt(times, values, tClose);
    console.log(
      `${nodes[nodeIndex].name}.translation Δ = ` +
        open.value.map((v, i) => (close.value[i] - v).toFixed(6)).join(', '),
    );
  }
}
