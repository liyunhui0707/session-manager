'use strict';
const { imageProjection, contentImages, eventImages, mergeImages } = require('./codex-page-image-projection');
const { TextState, fold } = require('./codex-page-text-state');
const TEXT = Symbol('source text'), CONTENT = Symbol('joined content');
const isText = value => !!value?.[TEXT];
const supported = block => ['input_text', 'output_text'].includes(block?.type) && isText(block.text);

// Descriptors keep hashes, lengths and bounded previews, never an unbounded body.
// Joining block hashes requires streaming the actual decoded bytes, not hashing
// individual digests. Candidate hash states let late/duplicate block types and
// text keys retain JSON's last-key-wins semantics without retaining those bytes.
function textProjection(recordNumber, query = '') {
  let field = 0;
  const arrays = new WeakMap(), candidates = new WeakMap(), parents = new WeakMap();
  return {
    createImage: imageProjection(recordNumber),
    createText(frames) {
      const id = `${recordNumber}:${field++}`;
      const block = frames.at(-1), array = frames.at(-2);
      const inContent = block?.path?.join('.') === 'payload.content.*' &&
        block.key === 'text' && array?.kind === 'array';
      const state = inContent ? null : new TextState(fold(query));
      let joined, length = 0;
      if (inContent) {
        const previous = arrays.get(array);
        joined = previous ? previous.clone() : new TextState(fold(query));
        if (previous) joined.write('\n\n');
        parents.set(block, array);
      }
      return {
        write(text) {
          state?.write(text); joined?.write(text); length += text.length;
        },
        finish() {
          const value = { [TEXT]: true, ...(state ? state.summary() : { length }), refs: [{ id, length }] };
          if (joined) candidates.set(value, joined);
          return value;
        },
      };
    },
    finishContainer(frame) {
      if (frame.path?.join('.') === 'payload' && frame.value?.type === 'user_message') {
        const images = eventImages(frame.value);
        if (images.length) frame.value.message = { ...(isText(frame.value.message) ? frame.value.message :
          { [TEXT]: true, ...new TextState(fold(query)).summary(), refs: [] }), images };
      }
      if (parents.has(frame) && supported(frame.value)) {
        arrays.set(parents.get(frame), candidates.get(frame.value.text));
      }
      // Only the joined body's small inline cache survives a content block.
      // Retaining one cache per block would multiply memory by the array length.
      if (parents.has(frame) && isText(frame.value.text)) {
        candidates.delete(frame.value.text);
        delete frame.value.text.text;
      }
      if (frame.path?.join('.') !== 'payload.content' || frame.kind !== 'array') return;
      const blocks = frame.value.filter(supported).map(block => block.text);
      const state = arrays.get(frame) || new TextState(fold(query));
      const refs = blocks.flatMap((body, i) => i ? [{ literal: '\n\n', length: 2 }, ...body.refs] : body.refs);
      frame.value[CONTENT] = { [TEXT]: true, ...state.summary(), refs, images: contentImages(frame.value) };
    },
  };
}
const textPolicy = {
  isText,
  hasContent: value => isText(value) && (value.length > 0 || value.images?.length > 0),
  merge: mergeImages,
  restore: value => ({ ...value, [TEXT]: true }),
  equal: (a, b) => isText(a) && isText(b) && a.length === b.length && a.digest === b.digest,
  check: value => value,
  join: blocks => blocks[CONTENT],
  setup: value => /^(?:# AGENTS\.md instructions\b|<environment_context>|<INSTRUCTIONS>|<permissions instructions>|<skills_instructions>)/.test(value.head),
};
module.exports = { textProjection, textPolicy };
