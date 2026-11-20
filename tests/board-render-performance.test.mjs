import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const web = (file) => readFileSync(new URL(`../board/web/${file}`, import.meta.url), 'utf8');

test('曲线坐标变化只更新原来的 polyline，复用采样不用重建 SVG', () => {
  const source = web('07-table.js'), writes = [];
  const line = { setAttribute: (...args) => writes.push(args) };
  let created = 0;
  const cell = { set innerHTML(_) { created++; this.firstChild = { firstChild: line }; } };
  const context = vm.createContext({ cell });
  vm.runInContext(`${source}\nconst pts = [0, 20, 10];
    sparkSvg(cell, pts); sparkSvg(cell, pts); sparkSvg(cell, [...pts]); sparkSvg(cell, [0, 20, 0]);`, context);
  assert.equal(created, 1);
  assert.deepEqual(writes, [['points', '0,16.0 50,2.0 100,9.0'], ['points', '0,16.0 50,2.0 100,16.0']]);
});

test('不同分辨率的画布交替画时不再重分配辉光缓冲', () => {
  const source = web('08-fx.js'), start = source.indexOf('const GLOW ='), end = source.indexOf('// 柔光画在哪', start);
  let allocations = 0, resizes = 0;
  const document = { createElement: () => {
    allocations++;
    let w = 0, h = 0;
    return { get width() { return w; }, set width(v) { w = v; resizes++; },
      get height() { return h; }, set height(v) { h = v; resizes++; },
      getContext: () => ({ setTransform() {}, clearRect() {} }) };
  } };
  const context = vm.createContext({ document, Q: new URLSearchParams() });
  vm.runInContext(`${source.slice(start, end)}\nglobalThis.glowBegin = glowBegin;`, context);
  const a = { canvas: { width: 300, height: 300 } }, b = { canvas: { width: 600, height: 600 } };
  context.glowBegin(a); context.glowBegin(b);
  assert.equal(allocations, 4); assert.equal(resizes, 8);
  for (let i = 0; i < 10; i++) { context.glowBegin(a); context.glowBegin(b); }
  assert.equal(allocations, 4); assert.equal(resizes, 8);
  b.canvas.height = 900; context.glowBegin(b);
  assert.equal(allocations, 4); assert.equal(resizes, 10);
});
