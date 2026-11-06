'use strict';
const STRIDE = 128 * 1024, LOOKBACK = 4096;
const high = code => code >= 0xd800 && code <= 0xdbff;
const low = code => code >= 0xdc00 && code <= 0xdfff;
function boundary(text, cut, base = 0) {
  const relative = cut - base;
  const newline = text.lastIndexOf('\n', relative - 1);
  if (newline >= 0 && newline >= relative - LOOKBACK) return base + newline + 1;
  return high(text.charCodeAt(relative - 1)) && low(text.charCodeAt(relative)) ? cut - 1 : cut;
}
module.exports = { STRIDE, LOOKBACK, boundary };
