'use strict';
(function () {
const MAX_IMAGE_BYTES = 8 * 1024 * 1024, MAX_PIXELS = 24000000;
const active = new WeakMap();
const queues = new WeakMap();
const leases = new WeakMap();
function inspectLocalImage(bytes) {
  const bad = () => new Error('请选择 8 MiB 以内、2400 万像素以内的 PNG 或 JPEG 图片。');
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_IMAGE_BYTES || bytes.length < 8) throw bad();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width, height, mime;
  if ([137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v)) {
    if (bytes.length < 33 || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) throw bad();
    width = view.getUint32(16); height = view.getUint32(20); mime = 'image/png';
    // Reject animation before decode; a small compressed file can hold many frames.
    for (let offset = 33; offset < bytes.length;) {
      if (offset + 12 > bytes.length) throw bad();
      const length = view.getUint32(offset), type = view.getUint32(offset + 4);
      if (offset + 12 + length > bytes.length || type === 0x6163544c || type === 0x49484452) throw bad();
      offset += 12 + length;
    }
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) throw bad();
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) throw bad();
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (width || length < 8 || bytes[offset + 2] !== 8) throw bad();
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); mime = 'image/jpeg';
      }
      offset += length;
    }
  }
  if (!mime || !width || !height) throw bad();
  if (width > 16384 || height > 16384 || width * height > MAX_PIXELS) {
    throw Object.assign(new Error('图片像素过多：最多支持 2400 万像素，单边不超过 16384 像素。'), { reason: 'pixel-limit' });
  }
  return { mime, width, height };
}

function closeLocalImagePreview(doc) {
  for (const dispose of active.get(doc) || []) dispose();
  active.delete(doc); leases.delete(doc);
}
function queue(doc, work) {
  const next = (queues.get(doc) || Promise.resolve()).catch(() => {}).then(work);
  queues.set(doc, next); return next;
}
const reasons = {
  'missing-image': '原图已不存在，可能已被临时文件清理。可手动选择原图。',
  'restricted-image': '原图位于自动读取范围之外，可手动选择图片。',
  'large-image': '原图超过 8 MiB，可手动选择较小的图片。',
  'unsupported-image': '图片格式暂不支持或文件损坏，请选择静态 PNG 或 JPEG。',
  'pixel-limit': '原图像素过多：支持 2400 万像素以内、单边不超过 16384 像素的图片，可手动选择缩小后的副本。',
  'stale-image': '会话已切换，请在当前会话中重新查看图片。',
  'changed-image': '原图正在变化，请稍后重新加载。',
  'in-progress': '正在读取会话，请稍后点击加载图片。',
};

function attachLocalImagePicker(container, doc, label, loadImage) {
  const win = doc.defaultView;
  if (!win) return; // Text-only indexing and server-side rendering never open files.
  const input = doc.createElement('input');
  input.type = 'file'; input.accept = 'image/png,image/jpeg'; input.hidden = true;
  const choose = doc.createElement('button'); choose.type = 'button'; choose.textContent = '选择图片预览';
  const status = doc.createElement('p'); status.className = 'attachment-note'; status.setAttribute('role', 'status');
  const preview = doc.createElement('div'); preview.className = 'attachment-preview';
  const load = doc.createElement('button'); load.type = 'button'; load.textContent = '加载图片'; load.hidden = !loadImage;
  const enlarge = doc.createElement('button'); enlarge.type = 'button'; enlarge.textContent = '查看大图';
  const close = doc.createElement('button'); close.type = 'button'; close.textContent = '关闭预览'; close.className = 'attachment-close';
  let generation = 0, objectUrl = null, closeZoom = null, observer, disposed = false;
  let dismissed = false, current = null, image = null;
  // Release decoded pixels and closures holding file bytes without collapsing
  // the image's responsive slot or changing the controls/status line geometry.
  function release() {
    generation++;
    closeZoom?.(); closeZoom = null;
    if (objectUrl) win.URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    image?.remove(); image = null; current = null; enlarge.disabled = true;
    leases.get(doc)?.delete(release);
    load.disabled = false;
  }
  function clear() {
    release(); preview.replaceChildren(); input.value = ''; status.textContent = '';
  }
  function reserve() {
    if (!leases.has(doc)) leases.set(doc, new Set());
    const slots = leases.get(doc);
    while (slots.size >= 4) slots.values().next().value();
    slots.add(release);
  }
  function render(bytes, info, name, automatic) {
    const dimensions = inspectLocalImage(bytes);
    reserve();
    const imageToken = generation;
    objectUrl = win.URL.createObjectURL(new win.Blob([bytes], { type: info.mime }));
    const img = doc.createElement('img'); img.alt = `${label}：${name}`;
    img.addEventListener('error', () => {
      if (generation !== imageToken) return;
      clear(); status.textContent = '图片无法解码，请重新选择有效的 PNG 或 JPEG 文件。';
    });
    img.src = objectUrl;
    const slot = doc.createElement('div'); slot.className = 'attachment-image-slot';
    function sizeSlot(width, height) {
      slot.style.width = `${Math.min(width, 540 * width / height)}px`;
      slot.style.aspectRatio = `${width} / ${height}`;
    }
    sizeSlot(dimensions.width, dimensions.height);
    // The thumbnail can have rounded dimensions; JPEG decoding can also apply
    // orientation. Keep the slot consistent with the pixels actually displayed.
    img.addEventListener('load', () => {
      if (generation === imageToken) sizeSlot(img.naturalWidth, img.naturalHeight);
    });
    slot.append(img); image = img;
    current = { bytes: automatic ? null : bytes, info, automatic };
    enlarge.disabled = false;
    img.addEventListener('click', () => enlarge.click());
    preview.replaceChildren(); preview.append(slot, enlarge, close);
    status.textContent = `${automatic ? '已关联原图' : '本次预览：' + name} · ${info.width} × ${info.height}${automatic ? '' : ' · 未保存到会话'}`;
  }
  async function automatic() {
    if (!loadImage || disposed) return;
    release(); const token = generation; load.disabled = true;
    if (!preview.children.length) status.textContent = '正在加载图片…';
    try {
      const result = await queue(doc, () => disposed || token !== generation ? null : loadImage('preview'));
      if (!result || disposed || token !== generation || !container.isConnected) return;
      if (!result.ok) throw new Error(reasons[result.reason] || '原图暂时无法读取，可手动选择图片。');
      render(result.bytes, result, label, true);
    } catch (error) { if (token === generation) status.textContent = error.message; }
    finally { if (token === generation) load.disabled = false; }
  }
  enlarge.addEventListener('click', async () => {
    if (!current) return;
    const token = generation; enlarge.disabled = true;
    try {
      const original = current.automatic ? await queue(doc, () => loadImage('original'))
        : { ok: true, bytes: current.bytes, ...current.info };
      if (disposed || token !== generation || !container.isConnected) return;
      if (!original.ok) throw new Error(reasons[original.reason] || '原图暂时无法读取，可重新选择图片。');
      const { showImageLightbox } = typeof require !== 'undefined' ? require('./image-lightbox') : window.SessionViewer;
      closeZoom = showImageLightbox(doc, original.bytes, original, label, enlarge);
    } catch (error) { if (token === generation) status.textContent = error.message; }
    finally { if (token === generation) enlarge.disabled = false; }
  });
  close.addEventListener('click', () => { dismissed = true; clear(); choose.focus(); });
  load.addEventListener('click', () => { dismissed = false; return automatic(); });
  choose.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    dismissed = false; clear();
    const token = generation;
    try {
      if (file.size > MAX_IMAGE_BYTES) throw new Error('图片超过 8 MiB，请选择较小的 PNG 或 JPEG 图片。');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (token !== generation || !container.isConnected) return;
      const info = inspectLocalImage(bytes);
      render(bytes, info, file.name, false);
    } catch (error) {
      if (token === generation) { clear(); status.textContent = error.message; }
    }
  });
  container.append(input, load, choose, status, preview);
  if (!active.has(doc)) active.set(doc, new Set());
  active.get(doc).add(() => { disposed = true; observer?.disconnect(); clear(); });
  if (loadImage && win.IntersectionObserver) {
    let attempted = false;
    observer = new win.IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting && !attempted && !dismissed) { attempted = true; void automatic(); }
        else if (!entry.isIntersecting) {
          attempted = false;
          release();
        }
      }
    });
    observer.observe(container);
  }
}
const api = { inspectLocalImage, attachLocalImagePicker, closeLocalImagePreview, MAX_IMAGE_BYTES };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') Object.assign(window.SessionViewer = window.SessionViewer || {}, api);
})();
