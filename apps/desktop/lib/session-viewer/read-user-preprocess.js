// Stage S3 — user-turn line preprocessor for the Read-mode renderer.
// Extracted from Local-Web-Server/public/read-renderer.js (lines 171-232)
// to keep read-renderer.js under the 300-line cap. The logic is verbatim;
// only the calling shape changed: pure function returning { line, drop,
// emitSlash, state }.
//
// State machine handles Claude Code's user-message wrapper tags:
//   - <local-command-stdout>, <local-command-caveat>,
//     <local-command-stderr>, <system-reminder> — drop the whole block
//   - <command-name>foo</command-name> — store as pendingSlashCommand
//   - <command-message>…</command-message> — drop
//   - <command-args>…</command-args> — drop the wrapper, keep the body
//   - "Base directory for this skill:" until next User/Assistant H2 — drop

'use strict';

(function () {

const DROP_TAGS = [
  'local-command-stdout',
  'local-command-caveat',
  'local-command-stderr',
  'system-reminder',
];

function preprocessUserLine(line, state) {
  // state: { inDropTag, inSlashArgs, inSkillBody, pendingSlashCommand }
  // returns:
  //   { drop: true, emitSlash: false }                — skip this line
  //   { drop: true, emitSlash: true }                 — skip; flush pending slash first
  //   { drop: false, emitSlash: false, line: <str>, captureSlash: <str|null> }
  //                                                   — render this line; optionally capture a slash command

  if (state.inDropTag) {
    if (/^##\s+(User|Assistant)(?:\s+—|$)/.test(line)) {
      state.inDropTag = null;
    } else {
      if (new RegExp(`</${state.inDropTag}>`).test(line)) state.inDropTag = null;
      return { drop: true, emitSlash: false };
    }
  }

  // Stage S5 round-7 QA fix: drop `[Image: source: /path/to/cache.png]`
  // lines from the rendered transcript. The importer writes these
  // alongside `[Image #N]` placeholders for the chat client's image
  // attachments; the source path is meaningful to the importer's
  // round-trip layer but is just noise in the human-readable Read view.
  // Pattern matches lines that are exclusively `[Image: source: <path>]`
  // (optional surrounding whitespace) — leaves anything with trailing
  // prose alone.
  if (/^\s*\[Image:\s+source:\s+[^\]]+\]\s*$/.test(line)) {
    return { drop: true, emitSlash: false };
  }

  for (const tag of DROP_TAGS) {
    if (new RegExp(`^\\s*<${tag}>.*</${tag}>\\s*$`).test(line)) {
      return { drop: true, emitSlash: true };
    }
    if (new RegExp(`^\\s*<${tag}>`).test(line)) {
      state.inDropTag = tag;
      return { drop: true, emitSlash: true };
    }
  }

  const cnameMatch = /^\s*<command-name>(.*)<\/command-name>\s*$/.exec(line);
  if (cnameMatch) {
    return { drop: true, emitSlash: false, captureSlash: cnameMatch[1] };
  }
  if (/^\s*<command-message>.*<\/command-message>\s*$/.test(line)) {
    return { drop: true, emitSlash: false };
  }

  let nextLine = line;
  const cargsSelfMatch = /^\s*<command-args>(.*)<\/command-args>\s*$/.exec(line);
  if (cargsSelfMatch) {
    nextLine = cargsSelfMatch[1];
  } else {
    const cargsOpenMatch = /^\s*<command-args>(.*)$/.exec(line);
    if (cargsOpenMatch) {
      state.inSlashArgs = true;
      nextLine = cargsOpenMatch[1];
    } else if (state.inSlashArgs) {
      const cargsCloseMatch = /^(.*)<\/command-args>\s*$/.exec(line);
      if (cargsCloseMatch) {
        nextLine = cargsCloseMatch[1];
        state.inSlashArgs = false;
        state.inSkillBody = false;
      }
    }
  }

  if (/^Base directory for this skill:/.test(nextLine)) {
    state.inSkillBody = true;
    return { drop: true, emitSlash: false };
  }
  if (state.inSkillBody) {
    if (/^##\s+(User|Assistant)(?:\s+—|$)/.test(nextLine)) {
      state.inSkillBody = false;
    } else {
      return { drop: true, emitSlash: false };
    }
  }

  return { drop: false, emitSlash: false, line: nextLine };
}

const api = { preprocessUserLine };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}

if (typeof window !== 'undefined') {
  window.SessionViewer = Object.assign(window.SessionViewer || {}, {
    _readUserPreprocess: api,
  });
}

})();
