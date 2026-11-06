'use strict';
module.exports = async function navigate(e, direction) {
  const before = await e("document.getElementById('transcriptPageStatus').textContent");
  await e(`document.getElementById('transcript${direction === 'previous' ? 'Previous' : 'Next'}').click()`);
  for (let i = 0; i < 600; i++) {
    if (await e(`!sessionManagerApp.isBusy() && document.getElementById('transcriptPageStatus').textContent !== ${JSON.stringify(before)}`)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('Conversation navigation timed out');
};
