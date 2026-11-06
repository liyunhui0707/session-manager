'use strict';
const preview = document.getElementById('app-preview');
const theme = document.querySelector('.theme-toggle');
const dialog = document.getElementById('image-dialog');
theme.addEventListener('click', () => {
  const dark = theme.getAttribute('aria-pressed') !== 'true';
  theme.setAttribute('aria-pressed', String(dark));
  theme.textContent = dark ? '查看浅色外观 ◑' : '查看深色外观 ◐';
  preview.src = dark ? 'assets/reader-dark.png' : 'assets/reader-preview.png';
  preview.alt = `Session Manager ${dark ? '深色' : '浅色'}界面，内容为虚构演示`;
});
document.querySelector('.preview').addEventListener('click', () => {
  dialog.querySelector('img').src = preview.src;
  dialog.showModal();
});
document.getElementById('close-preview').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
