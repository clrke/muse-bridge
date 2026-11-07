import { describe, it, expect } from 'vitest';
import { parseJsonResponse, stripJson, extractDecision } from '../src/command-router.js';

describe('parseJsonResponse', () => {
  it('parses raw JSON with message and decision', () => {
    const text = '{"tldr": "Hello world", "decision": {"summary": "what next", "rating": 5}}';
    const result = parseJsonResponse(text);
    expect(result).not.toBeNull();
    expect(result!.tldr).toBe('Hello world');
    expect(result!.decision?.summary).toBe('what next');
    expect(result!.decision?.rating).toBe(5);
  });

  it('parses raw JSON with null decision', () => {
    const text = '{"tldr": "Done!", "decision": null}';
    const result = parseJsonResponse(text);
    expect(result).not.toBeNull();
    expect(result!.tldr).toBe('Done!');
    expect(result!.decision).toBeNull();
  });

  it('parses JSON in markdown code fence', () => {
    const text = '```json\n{"tldr": "Hello", "decision": {"summary": "pick a color", "rating": 2}}\n```';
    const result = parseJsonResponse(text);
    expect(result).not.toBeNull();
    expect(result!.tldr).toBe('Hello');
    expect(result!.decision?.rating).toBe(2);
  });

  it('parses JSON in code fence without json label', () => {
    const text = '```\n{"tldr": "Hi", "decision": null}\n```';
    const result = parseJsonResponse(text);
    expect(result).not.toBeNull();
    expect(result!.tldr).toBe('Hi');
  });

  it('parses JSON with multiline message', () => {
    const text = '{"tldr": "Line 1\\nLine 2\\nLine 3", "decision": {"summary": "continue?", "rating": 0}}';
    const result = parseJsonResponse(text);
    expect(result).not.toBeNull();
    expect(result!.tldr).toContain('Line 1');
    expect(result!.decision?.rating).toBe(0);
  });

  it('parses JSON with special characters in message', () => {
    const text = '{"tldr": "Here\'s the code: `const x = 1;` and **bold** text", "decision": null}';
    const result = parseJsonResponse(text);
    expect(result).not.toBeNull();
    expect(result!.tldr).toContain('const x = 1');
  });

  it('returns null for plain text', () => {
    const text = 'This is just a regular message without JSON';
    expect(parseJsonResponse(text)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    const text = '{"tldr": broken}';
    expect(parseJsonResponse(text)).toBeNull();
  });

  it('returns null for JSON without message field', () => {
    const text = '{"response": "hello", "status": "ok"}';
    expect(parseJsonResponse(text)).toBeNull();
  });

  it('handles JSON with whitespace/newlines around it', () => {
    const text = '\n  {"tldr": "padded", "decision": null}  \n';
    const result = parseJsonResponse(text);
    expect(result).not.toBeNull();
    expect(result!.tldr).toBe('padded');
  });

  it('parses JSON with rating 0 decision', () => {
    const text = '{"tldr": "Committed and pushed.", "decision": {"summary": "proceed with tests?", "rating": 0}}';
    const result = parseJsonResponse(text);
    expect(result).not.toBeNull();
    expect(result!.decision?.rating).toBe(0);
    expect(result!.decision?.summary).toBe('proceed with tests?');
  });

  it('parses JSON with rating 10 decision', () => {
    const text = '{"tldr": "This will delete all data.", "decision": {"summary": "delete production database", "rating": 10}}';
    const result = parseJsonResponse(text);
    expect(result).not.toBeNull();
    expect(result!.decision?.rating).toBe(10);
  });

  it('parses JSON preceded by text', () => {
    const text = 'Here is my response:\n{"tldr": "embedded", "decision": null}';
    const result = parseJsonResponse(text);
    expect(result).not.toBeNull();
    expect(result!.tldr).toBe('embedded');
  });

  it('handles code fence with extra whitespace', () => {
    const text = '```json\n\n  {"tldr": "spaced", "decision": null}\n\n```';
    const result = parseJsonResponse(text);
    expect(result).not.toBeNull();
    expect(result!.tldr).toBe('spaced');
  });
});

describe('parseJsonResponse — lenient fallback for truncated JSON', () => {
  it('extracts message from truncated JSON cut off mid-string', () => {
    // The agent hit its output limit before closing the message string + decision block
    const text = '{"tldr": "## Header\\n\\nLong body that ends mid-sentence not an ash';
    const result = parseJsonResponse(text);
    expect(result).not.toBeNull();
    expect(result!.tldr).toContain('Long body that ends mid-sentence');
    expect(result!.decision).toBeNull();
  });

  it('handles escaped quotes in truncated JSON', () => {
    const text = '{"tldr": "She said \\"hi\\" then trailed';
    const result = parseJsonResponse(text);
    expect(result).not.toBeNull();
    expect(result!.tldr).toBe('She said "hi" then trailed');
    expect(result!.decision).toBeNull();
  });

  it('handles markdown tables in truncated JSON', () => {
    const text = '{"tldr": "| col |\\n|---|\\n| val |\\n\\nmore text without';
    const result = parseJsonResponse(text);
    expect(result).not.toBeNull();
    expect(result!.tldr).toContain('| col |');
    expect(result!.tldr).toContain('more text without');
  });

  it('does not match plain text without {"tldr"', () => {
    expect(parseJsonResponse('{broken')).toBeNull();
    expect(parseJsonResponse('Just text')).toBeNull();
    expect(parseJsonResponse('{"foo": "bar"')).toBeNull();
  });

  it('still prefers complete JSON when both forms are present', () => {
    const text = '{"tldr": "complete", "decision": null}';
    const result = parseJsonResponse(text);
    expect(result!.tldr).toBe('complete');
    expect(result!.decision).toBeNull();
  });
});

describe('stripJson', () => {
  it('extracts message from JSON with TLDR header', () => {
    expect(stripJson('{"tldr": "Hello", "decision": null}')).toBe('# TLDR\nHello');
  });

  it('returns original text when not JSON', () => {
    expect(stripJson('Just plain text')).toBe('Just plain text');
  });

  it('returns original text for invalid JSON', () => {
    expect(stripJson('{broken')).toBe('{broken');
  });

  it('extracts message via TLDR header even from truncated JSON', () => {
    // Regression for the pros/cons display showing raw {"tldr": "...
    const text = '{"tldr": "Pros & Cons body that was cut off';
    expect(stripJson(text)).toBe('# TLDR\nPros & Cons body that was cut off');
  });
});

describe('extractDecision', () => {
  it('extracts decision from JSON', () => {
    const text = '{"tldr": "x", "decision": {"summary": "pick framework", "rating": 7}}';
    const decision = extractDecision(text);
    expect(decision).not.toBeNull();
    expect(decision!.summary).toBe('pick framework');
    expect(decision!.rating).toBe(7);
  });

  it('returns null when decision is null', () => {
    const text = '{"tldr": "done", "decision": null}';
    expect(extractDecision(text)).toBeNull();
  });

  it('returns null for non-JSON text', () => {
    expect(extractDecision('plain text')).toBeNull();
  });

  it('returns null for JSON without decision field', () => {
    expect(extractDecision('{"tldr": "hi"}')).toBeNull();
  });
});
