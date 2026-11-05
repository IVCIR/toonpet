// 读 GLB 的 JSON+BIN，列出"眼皮/眼球"节点在各动画里的通道与取值范围（只读本地文件）。
// 用途：确认眨眼到底动哪根骨、哪个轴、幅度多少（ADR 0026 D7 只记了结论，没记轴）。
const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2] ?? path.join(__dirname, '..', 'CH0335.glb');
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
if (!json || !bin) {
  console.error('no glb json/bin');
  process.exit(1);
}

const nodes = json.nodes ?? [];
const accessors = json.accessors ?? [];
const views = json.bufferViews ?? [];

function readAccessor(index) {
  const acc = accessors[index];
  const view = views[acc.bufferView];
  const components = { SCALAR: 1, VEC3: 3, VEC4: 4 }[acc.type] ?? 1;
  const start = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const count = acc.count;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const values = [];
    for (let c = 0; c < components; c += 1) {
      const at = start + (i * components + c) * 4;
      values.push(bin.readFloatLE(at));
    }
    out.push(components === 1 ? values[0] : values);
  }
  return out;
}

function range(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) {
        min = Math.min(min, item);
        max = Math.max(max, item);
      }
    } else {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }
  return { min, max };
}

const eyeNodeIndices = new Set();
nodes.forEach((node, index) => {
  if (/eye/i.test(node.name ?? '')) {
    eyeNodeIndices.add(index);
    console.log(`node ${index}: ${node.name}`);
  }
});

for (const animation of json.animations ?? []) {
  if (!/Cafe_Idle|my_event088/.test(animation.name)) continue;
  console.log(`\n=== ${animation.name} (${animation.channels.length} channels) ===`);
  for (const channel of animation.channels) {
    const nodeIndex = channel.target.node;
    if (!eyeNodeIndices.has(nodeIndex)) continue;
    const sampler = animation.samplers[channel.sampler];
    const times = readAccessor(sampler.input);
    const values = readAccessor(sampler.output);
    const { min, max } = range(values);
    console.log(
      `  ${nodes[nodeIndex].name}.${channel.target.path}: keys=${values.length} ` +
        `t=${times[0].toFixed(2)}..${times[times.length - 1].toFixed(2)}s range=${min.toFixed(6)}..${max.toFixed(6)}`,
    );
    if (channel.target.path === 'translation') {
      // 打印前 6 个关键帧，确认"平时值 / 眨眼峰值"
      console.log('    head:', values.slice(0, 6).map((v) => v.map((x) => x.toFixed(6)).join(',')).join(' | '));
      const ranges = [0, 1, 2].map((axis) => {
        const list = values.map((v) => v[axis]);
        return range(list);
      });
      console.log(
        '    per-axis:',
        ranges.map((r, i) => `${'xyz'[i]}:${r.min.toFixed(6)}..${r.max.toFixed(6)}`).join(' '),
      );
    }
  }
}
