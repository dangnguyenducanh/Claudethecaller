/**
 * `sanitize`: the one place that cleans text before it reaches a model, a memory row or a graph label.
 * Called from: packages/core/src/memory (turn text, model replies), apps/worker/src/memory; later T2.x (graph labels, `maxChars`) and T4.3.
 * Why: spec:215 - control characters, `<private>` / `<system-reminder>` / `<persisted-output>` blocks and ctc's own injected `ctc: ` lines
 * must never become model input or stored text. Pure, no I/O.
 * Deliberately NOT done: trimming, whitespace collapsing, HTML or markdown handling, secret detection beyond the tag blocks.
 */

export const CTC_LINE_PREFIX = 'ctc: ';

const BLOCK_TAGS = ['private', 'system-reminder', 'persisted-output'] as const;
const CTC_LINE = new RegExp(String.raw`^[^\S\r\n\u2028\u2029]*${CTC_LINE_PREFIX}[^\n]*(?:\n|$)`, 'gm');
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Removes every block from `<tag>` to the first `</tag>` after it (both included) for the given tags; case-sensitive, no attributes.
 * An opening tag without a closing tag removes everything to the end; a lone closing tag is kept. Pure; a non-string gives `''`.
 * One left-to-right pass: after a removal only the joint (the last `<tag>` length of kept text + the next text) is re-checked, so a tag built
 * by removing another is removed too (D10) at a cost that does not grow with nesting depth.
 */
export function stripBlocks(text: string, tags: readonly string[]): string {
  if (typeof text !== 'string') return '';
  const next = new Map<string, number>(tags.map((t) => [t, -2]));
  const keep = Math.max(0, ...tags.map((t) => t.length + 1));
  const parts: string[] = [];
  const tail = (): string => {
    let s = '';
    for (let k = parts.length - 1; k >= 0 && s.length < keep; k--) s = (parts[k] as string).slice(-(keep - s.length)) + s;
    return s;
  };
  const drop = (n: number): void => {
    while (n > 0 && parts.length > 0) {
      const last = parts.pop() as string;
      if (last.length > n) parts.push(last.slice(0, last.length - n));
      n -= last.length;
    }
  };
  let pos = 0;
  for (;;) {
    let at = -1;
    let tag = '';
    let cut = 0;
    if (parts.length > 0) {
      const kept = tail();
      const joint = kept + text.slice(pos, pos + keep);
      for (const t of tags) {
        const open = `<${t}>`;
        const i = joint.indexOf(open, Math.max(0, kept.length - open.length + 1));
        if (i >= 0 && i < kept.length && (at < 0 || i < at)) {
          at = i;
          tag = t;
          cut = kept.length - i;
        }
      }
    }
    if (at >= 0) {
      drop(cut);
      at = pos - cut;
    } else {
      for (const t of tags) {
        let i = next.get(t) ?? -1;
        if (i === -2 || (i >= 0 && i < pos)) {
          i = text.indexOf(`<${t}>`, pos);
          next.set(t, i);
        }
        if (i >= 0 && (at < 0 || i < at)) {
          at = i;
          tag = t;
        }
      }
      if (at < 0) {
        if (pos === 0) return text;
        if (pos < text.length) parts.push(text.slice(pos));
        return parts.join('');
      }
      if (at > pos) parts.push(text.slice(pos, at));
    }
    const close = text.indexOf(`</${tag}>`, at + tag.length + 2);
    if (close < 0) return parts.join('');
    pos = close + tag.length + 3;
  }
}

/** The first `max` UTF-16 code units of `text`, one shorter when the cut would split a surrogate pair. */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** See the module header and D10 (the loop runs a few times at most: only control removal can build a new tag, and only once): tag blocks, `ctc: ` lines, control characters, then the optional `maxChars` cut. Never throws. */
export function sanitize(text: string, o?: { maxChars?: number }): string {
  if (typeof text !== 'string') return '';
  let out = text;
  for (let prev = ''; prev !== out; ) {
    prev = out;
    out = stripBlocks(out, BLOCK_TAGS).replace(CTC_LINE, '').replace(CONTROL, '');
  }
  const max = o?.maxChars;
  if (typeof max === 'number' && Number.isInteger(max) && max > 0) out = cut(out, max);
  return out;
}
