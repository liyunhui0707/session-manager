'use strict';

(function () {

function formatRefreshResult(result, reloadFailed = false) {
  const reasons = {
    'no-library': '请先选择会话库，再重新导入。',
    'in-progress': '正在导入，请稍候。',
    'platform-unsupported': '当前系统不支持安全导入。',
  };
  const agents = result && [result.claude, result.codex];
  let isError = !result || !result.ok;
  let text;
  if (agents && agents.every(Boolean)) {
    isError = isError || agents.some((agent) => !agent.ok || agent.errors > 0);
    const partial = agents.some((agent) => agent.ok || agent.imported > 0);
    const lead = !isError ? '导入完成。'
      : partial ? '部分导入完成，另有文件未能导入。' : '导入失败。';
    const lines = agents.map((agent, index) => {
      const label = index === 0 ? 'Claude' : 'Codex';
      if (Number.isSafeInteger(agent.imported)) {
        return `${label}：已导入 ${agent.imported}，跳过 ${agent.skipped}，失败 ${agent.errors}`
          + (agent.note === 'no-source' ? '（未找到来源）' : '');
      }
      return `${label}：导入失败，统计暂不可用。`
        + (agent.reason === 'platform-unsupported' ? ' 当前系统不支持安全导入。' : '');
    });
    text = [lead, ...lines].join('\n');
  } else {
    text = result && result.ok ? '导入完成。'
      : reasons[result && result.reason] || '导入失败，结果暂不可用。';
  }
  if (reloadFailed) {
    text += '\n无法重新读取会话库。 可重新选择会话库再试，无需再次导入。';
    isError = true;
  }
  return { text, isError };
}

const api = { formatRefreshResult };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') {
  window.SessionViewer = Object.assign(window.SessionViewer || {}, api);
}

})();
