// 只读列出 GLB 里的全部动画片段（名字 + 时长 + 通道数），不启动 Electron。
//
// 为什么单独做一个：`census.cjs` 要在页面里跑 WebGL 才能量骨骼，但"这个模型到底有哪几段、
// 各多长"只读 GLB 的 JSON chunk 就够了，冷启动排查/换模型时比开预览页快得多。
//
// 用法：node tools/clip-preview/list-clips.cjs [模型路径]
// 缺省读工程根目录的 CH0335.glb；不写文件、不联网。
const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2] ?? path.join(__dirname, '..', '..', 'CH0335.glb');
const buf = fs.readFileSync(file);
const magic = buf.readUInt32LE(0);
const version = buf.readUInt32LE(4);
const total = buf.readUInt32LE(8);

let offset = 12;
let json = null;
while (offset < buf.length) {
  const length = buf.readUInt32LE(offset);
  const type = buf.readUInt32LE(offset + 4);
  const chunk = buf.subarray(offset + 8, offset + 8 + length);
  // 0x4E4F534A = "JSON"（GLB 的 JSON chunk 类型标记）
  if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'));
  offset += 8 + length;
}

if (!json) {
  console.error('[clips] 没找到 JSON chunk：', file);
  process.exit(1);
}

const animations = json.animations ?? [];
console.log(
  `[clips] ${path.basename(file)} magic=${magic.toString(16)} version=${version} bytes=${total} animations=${animations.length}`,
);
animations.forEach((animation, index) => {
  const duration = Math.max(
    0,
    ...animation.samplers.map((sampler) => {
      const accessor = json.accessors[sampler.input];
      return accessor?.max ? accessor.max[0] : 0;
    }),
  );
  console.log(
    `${String(index).padStart(2, '0')} ${animation.name.padEnd(42)} ${duration.toFixed(2)}s channels=${animation.channels.length}`,
  );
});
