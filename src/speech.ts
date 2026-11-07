/**
 * Plain text for text-to-speech and captions: no markdown, code, URLs or emoji, one line.
 *
 * - Fenced code blocks and inline code spans are removed (reading code aloud helps nobody).
 * - Links and images keep their text (`[docs](https://x)` → `docs`); bare URLs are removed.
 * - Headings keep their text and end a sentence. The bridge's own section labels
 *   (`# TLDR`, `# Other Findings`, `# Assumptions Made`) are dropped.
 * - Emphasis, strikethrough, list and quote markers, Discord-style `-#` subtext, rules and
 *   table pipes are removed. Emoji (with their joiners, skin tones and variation selectors) too.
 * - Whitespace collapses to single spaces.
 */
const SECTION_LABEL_RE = /^(?:tl;?dr|other findings|assumptions made)$/i;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*/gi;
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}‍︎️⃣]/gu;

export function toSpeech(input: string | null | undefined): string {
  if (!input) return '';
  let s = String(input).replace(/\r\n?/g, '\n');

  s = s.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[ \t]*(?=\n|$)|$)/gm, ' ');
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/`+[^`\n]*`+/g, ' ');
  s = s.replace(/`/g, '');

  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
  s = s.replace(/^[ \t]*\[[^\]]+\]:[ \t]*\S+.*$/gm, '');
  s = s.replace(/<((?:https?:|mailto:)[^>]+)>/gi, '$1');
  s = s.replace(/<\/?[a-z][^>]*>/gi, ' ');
  s = s.replace(URL_RE, ' ');

  s = s.split('\n').map((line) => {
    let l = line.trim();
    if (/^(?:[-*_][ \t]*){3,}$/.test(l)) return '';
    if (/^\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?$/.test(l)) return '';
    const heading = l.match(/^#{1,6}[ \t]+(.*?)[ \t#]*$/) ?? l.match(/^-#[ \t]+(.*)$/);
    if (heading && l.startsWith('#')) {
      const text = heading[1].trim();
      if (!text || SECTION_LABEL_RE.test(stripEmphasis(text))) return '';
      return /[.!?:;]$/.test(text) ? text : `${text}.`;
    }
    if (heading) l = heading[1];
    l = l.replace(/^(?:>[ \t]?)+/, '');
    l = l.replace(/^(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/, '');
    return l;
  }).join('\n');

  s = stripEmphasis(s);
  s = s.replace(/\|/g, ' ');
  s = s.replace(EMOJI_RE, '');

  s = s.replace(/\s+/g, ' ');
  s = s.replace(/\(\s*\)/g, '');
  s = s.replace(/\s+([.,;:!?)])/g, '$1');
  s = s.replace(/([(])\s+/g, '$1');
  s = s.replace(/([.!?])(?:\s*[.:;,])+(?=\s|$)/g, '$1');
  return s.trim();
}

function stripEmphasis(s: string): string {
  return s
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')
    .replace(/\*\*|__/g, '');
}
