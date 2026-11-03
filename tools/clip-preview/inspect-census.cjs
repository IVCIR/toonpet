// 读 census.json，把候选片段的逐帧事实打成表（本地开发用）。
// 用法：node tools/clip-preview/inspect-census.cjs <片段名子串> [<另一个人> ...]
const { readFileSync } = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, 'shots', 'census.json');
const data = JSON.parse(readFileSync(file, 'utf8'));
const targets = process.argv.slice(2);

const rows = data.clips.filter((clip) =>
  targets.length === 0 ? true : targets.some((needle) => clip.name.includes(needle)),
);

for (const clip of rows) {
  const first = clip.samples[0];
  const baseHeight = first.head && first.footY !== null ? first.head.y - first.footY : null;
  console.log(`\n== ${clip.name}  ${clip.duration.toFixed(2)}s  baseHeight=${baseHeight?.toFixed(4)}`);
  console.log('   t   height  shrink   hand    dPitch  dRoll   headY');
  for (const s of clip.samples) {
    if (!s.head) continue;
    const height = s.footY !== null ? s.head.y - s.footY : null;
    const shrink = baseHeight && height ? (baseHeight - height) / baseHeight : null;
    const hand = s.handDistL !== null && s.handDistR !== null ? Math.min(s.handDistL, s.handDistR) : null;
    console.log(
      `${String(s.t).padStart(6)} ${height === null ? '   -  ' : height.toFixed(4)} ` +
        `${shrink === null ? '   -  ' : shrink.toFixed(3).padStart(6)} ` +
        `${hand === null ? '   -  ' : hand.toFixed(4)} ` +
        `${(s.headPitch - first.headPitch).toFixed(3).padStart(7)} ` +
        `${(s.headRoll - first.headRoll).toFixed(3).padStart(6)} ` +
        `${s.head.y.toFixed(4)}`,
    );
  }
}
