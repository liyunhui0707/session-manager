'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOperationStatus } = require('../../lib/session-viewer/operation-status');
function setup() {
  const node = () => ({ dataset: {}, setAttribute(k, v) { this[k] = v; }, addEventListener(k, fn) { this[k] = fn; } });
  const status = node(), retry = node(), mount = node();
  return { status, retry, mount, control: createOperationStatus(status, retry, mount) };
}
test('retry is explicit, single-flight, and replaced by the next operation', async () => {
  const h = setup(); let count = 0, finish;
  h.control.set('读取失败', true, () => { count++; return new Promise(resolve => { finish = resolve; }); });
  assert.equal(h.retry.hidden, false);
  const pending = h.retry.click();
  await h.retry.click(); assert.equal(count, 1);
  h.control.set('正在打开另一个来源');
  finish(); await pending;
  assert.equal(h.retry.hidden, true);
  await h.retry.click(); assert.equal(count, 1);
});
test('busy state is announced, disables retry and preserves error text', async () => {
  const h = setup(); let count = 0;
  h.control.set('读取失败，当前内容已保留', true, async () => { count++; });
  h.control.busy(true);
  assert.equal(h.status.dataset.kind, 'busy'); assert.equal(h.mount['aria-busy'], 'true');
  await h.retry.click(); assert.equal(count, 0);
  h.control.busy(false);
  assert.equal(h.status.dataset.kind, 'error');
  assert.equal(h.status.textContent, '读取失败，当前内容已保留');
  await h.retry.click(); assert.equal(count, 1);
});
