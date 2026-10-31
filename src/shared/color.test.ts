import assert from 'node:assert/strict';
import test from 'node:test';
import { pickDominantColor } from './color';

function rgba(pixels: Array<[number, number, number, number]>): Uint8ClampedArray {
  const data = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach(([r, g, b, a], index) => {
    data[index * 4] = r;
    data[index * 4 + 1] = g;
    data[index * 4 + 2] = b;
    data[index * 4 + 3] = a;
  });
  return data;
}

test('pickDominantColor：肤色占多数时返回肤色，不被深色眉毛/描边拖暗', () => {
  const skin: [number, number, number, number] = [249, 241, 236, 255];
  const brow: [number, number, number, number] = [40, 24, 24, 255];
  const pixels: Array<[number, number, number, number]> = [];
  for (let i = 0; i < 100; i += 1) pixels.push(skin);
  for (let i = 0; i < 20; i += 1) pixels.push(brow);

  const color = pickDominantColor(rgba(pixels));
  assert.ok(color);
  // 均值会是 (214, 205, 200) 这种发暗的值；众数必须贴近肤色
  assert.ok(Math.abs(color.r - 249) <= 2, `r=${color.r}`);
  assert.ok(Math.abs(color.g - 241) <= 2, `g=${color.g}`);
  assert.ok(Math.abs(color.b - 236) <= 2, `b=${color.b}`);
});

test('pickDominantColor：透明像素不参与统计', () => {
  const pixels: Array<[number, number, number, number]> = [];
  for (let i = 0; i < 90; i += 1) pixels.push([0, 0, 0, 0]);
  for (let i = 0; i < 10; i += 1) pixels.push([255, 128, 64, 255]);

  assert.deepEqual(pickDominantColor(rgba(pixels)), { r: 255, g: 128, b: 64 });
});

test('pickDominantColor：全透明或长度非法返回 null', () => {
  assert.equal(pickDominantColor(new Uint8ClampedArray(0)), null);
  assert.equal(pickDominantColor(new Uint8ClampedArray(3)), null);
  assert.equal(
    pickDominantColor(
      rgba([
        [1, 2, 3, 0],
        [1, 2, 3, 0],
      ]),
    ),
    null,
  );
});

test('pickDominantColor：没有显著主色（均匀渐变）时退回逐通道中位数', () => {
  const pixels: Array<[number, number, number, number]> = [];
  for (let value = 0; value < 200; value += 1) pixels.push([value, value, value, 255]);

  const color = pickDominantColor(rgba(pixels));
  assert.ok(color);
  assert.equal(color.r, 100, '中位数而不是均值 99.5 四舍五入');
  assert.equal(color.g, 100);
  assert.equal(color.b, 100);
});

test('pickDominantColor：单色贴图返回该颜色', () => {
  const pixels: Array<[number, number, number, number]> = [];
  for (let i = 0; i < 64; i += 1) pixels.push([12, 34, 56, 255]);
  assert.deepEqual(pickDominantColor(rgba(pixels)), { r: 12, g: 34, b: 56 });
});
