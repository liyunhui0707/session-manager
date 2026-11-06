export function jsonScalar(value) {
  return JSON.stringify(String(value));
}

export function buildFence(content) {
  let longest = 0;
  let run = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 96) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

export function truncate(s, max) {
  if (s.length <= max) return { rendered: s, truncated: false };
  return { rendered: s.slice(0, max), truncated: true };
}
