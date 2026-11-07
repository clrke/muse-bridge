import { describe, it, expect } from 'vitest';
import { toSpeech } from '../src/speech.js';

describe('toSpeech', () => {
  it.each([
    ['plain text stays', 'Tests pass.', 'Tests pass.'],
    ['headings keep their text and end a sentence', '## Summary\nAll good', 'Summary. All good'],
    ['heading punctuation is kept', '### Done!\nShipped', 'Done! Shipped'],
    ['bridge section labels are dropped', '# TLDR\nFixed the jump.', 'Fixed the jump.'],
    ['other section labels too', '# Other Findings\nCI is slow\n\n# Assumptions Made\nNone', 'CI is slow None'],
    ['Discord subtext marker', '-# small print here', 'small print here'],
    ['bold, italic, strikethrough', 'This is **bold**, __also__, *it*, _it2_ and ~~gone~~', 'This is bold, also, it, it2 and gone'],
    ['snake_case words are left alone', 'set max_retry_count', 'set max_retry_count'],
    ['links become their text', 'Read [the docs](https://example.com/docs) first', 'Read the docs first'],
    ['images become their alt text', 'See ![a chart](/tmp/c.png).', 'See a chart.'],
    ['bare URLs are removed', 'Opened https://github.com/a/b/pull/12 for review.', 'Opened for review.'],
    ['www URLs are removed', 'Docs at www.example.com now', 'Docs at now'],
    ['inline code is removed', 'Run `npm test` then commit', 'Run then commit'],
    ['fenced code blocks are removed', 'Before\n```ts\nconst x = 1;\n```\nAfter', 'Before After'],
    ['unterminated fence is removed to the end', 'Look:\n```\nrm -rf /', 'Look:'],
    ['list markers', '- one\n* two\n1. three\n- [x] four', 'one two three four'],
    ['blockquotes and rules', '> quoted\n---\nafter', 'quoted after'],
    ['emoji (incl. ZWJ, skin tones, flags, keycaps)', '✅ Done 🚀 👍🏽 👩‍💻 🇵🇭 1️⃣ ok', 'Done 1 ok'],
    ['bridge notices read well', '⏳ **Decision needed (rating 3):** pick a DB, auto-decides at 2026-11-07 14:00:00', 'Decision needed (rating 3): pick a DB, auto-decides at 2026-11-07 14:00:00'],
    ['whitespace collapses', '  a\n\n\tb   c  ', 'a b c'],
    ['table pipes', '| a | b |\n|---|---|\n| 1 | 2 |', 'a b 1 2'],
    ['empty and nullish', '', ''],
  ])('%s', (_name, input, expected) => {
    expect(toSpeech(input)).toBe(expected);
  });

  it('returns an empty string for null/undefined', () => {
    expect(toSpeech(null)).toBe('');
    expect(toSpeech(undefined)).toBe('');
  });

  it('handles mailto/tel links the chat formatter produces', () => {
    expect(toSpeech('Mail [a@b.co](mailto:a@b.co) or call [+1 555 123 4567](tel:+15551234567)')).toBe('Mail a@b.co or call +1 555 123 4567');
  });
});
