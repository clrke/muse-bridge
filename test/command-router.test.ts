import { describe, it, expect, vi } from 'vitest';
import { parseJsonResponse, stripJson, extractDecision, formatForChat, timeUntil, isJsonEnvelopeExempt } from '../src/command-router.js';

describe('parseJsonResponse', () => {
  it('parses raw JSON with message and decision', () => {
    const input = '{"tldr": "Hello world", "decision": {"summary": "what next", "rating": 5}}';
    const result = parseJsonResponse(input);
    expect(result).not.toBeNull();
    expect(result!.tldr).toBe('Hello world');
    expect(result!.decision?.summary).toBe('what next');
    expect(result!.decision?.rating).toBe(5);
  });

  it('parses raw JSON with null decision', () => {
    const input = '{"tldr": "Done!", "decision": null}';
    const result = parseJsonResponse(input);
    expect(result).not.toBeNull();
    expect(result!.tldr).toBe('Done!');
    expect(result!.decision).toBeNull();
  });

  it('parses JSON in markdown code fence', () => {
    const input = '```json\n{"tldr": "Hello", "decision": {"summary": "pick a framework", "rating": 7}}\n```';
    const result = parseJsonResponse(input);
    expect(result).not.toBeNull();
    expect(result!.tldr).toBe('Hello');
    expect(result!.decision?.rating).toBe(7);
  });

  it('parses JSON in code fence without json label', () => {
    const input = '```\n{"tldr": "Hi", "decision": null}\n```';
    const result = parseJsonResponse(input);
    expect(result).not.toBeNull();
    expect(result!.tldr).toBe('Hi');
  });

  it('parses JSON embedded in surrounding text', () => {
    const input = 'Here is my response:\n{"tldr": "Found 3 bugs", "decision": {"summary": "fix bugs", "rating": 2}}';
    const result = parseJsonResponse(input);
    expect(result).not.toBeNull();
    expect(result!.tldr).toBe('Found 3 bugs');
  });

  it('returns null for plain text', () => {
    const input = 'Just a regular message with no JSON';
    expect(parseJsonResponse(input)).toBeNull();
  });

  it('returns null for JSON without message field', () => {
    const input = '{"name": "test", "value": 42}';
    expect(parseJsonResponse(input)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseJsonResponse('')).toBeNull();
  });

  it('handles multiline message in JSON', () => {
    const input = '{"tldr": "Line 1\\nLine 2\\nLine 3", "decision": null}';
    const result = parseJsonResponse(input);
    expect(result).not.toBeNull();
    expect(result!.tldr).toContain('Line 1');
    expect(result!.tldr).toContain('Line 3');
  });

  it('handles rating 0 decision', () => {
    const input = '{"tldr": "Staged 3 files. Proceeding with commit.", "decision": {"summary": "proceed with commit and push", "rating": 0}}';
    const result = parseJsonResponse(input);
    expect(result).not.toBeNull();
    expect(result!.decision?.rating).toBe(0);
    expect(result!.decision?.summary).toBe('proceed with commit and push');
  });

  it('handles a real agent response with a long message', () => {
    const input = `{"tldr": "Here are the current rules for enemy reactions, from the code:\\n\\n### Priority System\\n\\nReactions are Priority 2c in a 6-tier system:\\n\\n1. Introduction\\n2. a) Welcome back → b) Hints → c) Reactions\\n3. Daily greeting", "decision": {"summary": "Should we differentiate ranged enemies' reactions from melee ones?", "rating": 5}}`;
    const result = parseJsonResponse(input);
    expect(result).not.toBeNull();
    expect(result!.tldr).toContain('Priority System');
    expect(result!.decision?.rating).toBe(5);
  });

  it('handles JSON with code fence and extra whitespace', () => {
    const input = '  ```json  \n  {"tldr": "test", "decision": null}  \n  ```  ';
    const result = parseJsonResponse(input);
    expect(result).not.toBeNull();
    expect(result!.tldr).toBe('test');
  });
});

describe('stripJson', () => {
  it('extracts message from JSON with TLDR header', () => {
    expect(stripJson('{"tldr": "Hello", "decision": null}')).toBe('# TLDR\nHello');
  });

  it('returns original text if not JSON', () => {
    expect(stripJson('Just plain text')).toBe('Just plain text');
  });

  it('returns original text for malformed JSON', () => {
    expect(stripJson('{broken json')).toBe('{broken json');
  });

  it('strips legacy __**TLDR**__ prefix from message', () => {
    const input = '{"tldr": "__**TLDR**__ This is the real content.", "decision": null}';
    expect(stripJson(input)).toBe('# TLDR\nThis is the real content.');
  });

  it('strips legacy # TLDR heading from message', () => {
    const input = '{"tldr": "# TLDR\\nActual content here.", "decision": null}';
    expect(stripJson(input)).toBe('# TLDR\nActual content here.');
  });

  it('strips ## TLDR variant from message', () => {
    const input = '{"tldr": "## TLDR\\nContent.", "decision": null}';
    expect(stripJson(input)).toBe('# TLDR\nContent.');
  });
});

describe('extractDecision', () => {
  it('extracts decision from JSON', () => {
    const decision = extractDecision('{"tldr": "Hi", "decision": {"summary": "pick DB", "rating": 6}}');
    expect(decision).not.toBeNull();
    expect(decision!.summary).toBe('pick DB');
    expect(decision!.rating).toBe(6);
  });

  it('returns null when decision is null in JSON', () => {
    expect(extractDecision('{"tldr": "Hi", "decision": null}')).toBeNull();
  });

  it('returns null for plain text', () => {
    expect(extractDecision('No JSON here')).toBeNull();
  });

  it('extracts rating 0 decision', () => {
    const decision = extractDecision('{"tldr": "Done", "decision": {"summary": "continue?", "rating": 0}}');
    expect(decision).not.toBeNull();
    expect(decision!.rating).toBe(0);
  });
});

describe('isJsonEnvelopeExempt', () => {
  it('exempts the bare NO_CONS token', () => {
    expect(isJsonEnvelopeExempt('NO_CONS')).toBe(true);
  });

  it('exempts NO_CONS with surrounding whitespace/newlines', () => {
    expect(isJsonEnvelopeExempt('  \nNO_CONS\n  ')).toBe(true);
  });

  it('does not exempt NO_CONS with extra trailing text', () => {
    expect(isJsonEnvelopeExempt('NO_CONS, but also here is more')).toBe(false);
  });

  it('exempts a strict PROS:/CONS: bullet block', () => {
    const input = 'PROS:\n- faster\n- simpler\n\nCONS:\n- riskier';
    expect(isJsonEnvelopeExempt(input)).toBe(true);
  });

  it('does not exempt PROS: without a CONS: section', () => {
    expect(isJsonEnvelopeExempt('PROS:\n- faster')).toBe(false);
  });

  it('does not exempt a normal JSON envelope', () => {
    const input = '{"tldr": "Hi", "decision": {"summary": "pick DB", "rating": 6}}';
    expect(isJsonEnvelopeExempt(input)).toBe(false);
  });

  it('does not exempt plain prose with no JSON', () => {
    expect(isJsonEnvelopeExempt('Just a regular message with no JSON')).toBe(false);
  });
});

describe('formatForChat', () => {
  it('converts a simple table to key-value format', () => {
    const input = '| Name | Status |\n| --- | --- |\n| ProjectA | Active |';
    const result = formatForChat(input);
    expect(result).toContain('**Name:** ProjectA');
    expect(result).toContain('**Status:** Active');
  });

  it('handles multiple data rows separated by blank lines', () => {
    const input = '| Name | Status |\n| --- | --- |\n| Alpha | Done |\n| Beta | Pending |';
    const result = formatForChat(input);
    expect(result).toContain('**Name:** Alpha');
    expect(result).toContain('**Status:** Done');
    expect(result).toContain('**Name:** Beta');
    expect(result).toContain('**Status:** Pending');
    // Rows should be separated by double newline
    expect(result).toContain('Done\n\n**Name:** Beta');
  });

  it('handles blank first column header', () => {
    const input = '| | Status | Notes |\n| --- | --- | --- |\n| ProjectA | Active | On track |';
    const result = formatForChat(input);
    // Blank header should show just the cell value, no "**:**"
    expect(result).toContain('ProjectA');
    expect(result).not.toContain('**:** ProjectA');
    expect(result).toContain('**Status:** Active');
    expect(result).toContain('**Notes:** On track');
  });

  it('preserves links in cells', () => {
    const input = '| File | Link |\n| --- | --- |\n| readme | [click here](https://example.com) |';
    const result = formatForChat(input);
    expect(result).toContain('[click here](https://example.com)');
    expect(result).not.toContain('```');
  });

  it('does not modify text without tables', () => {
    const input = 'Hello world\n\nThis is plain text.';
    expect(formatForChat(input)).toBe(input);
  });

  it('handles table embedded in surrounding text', () => {
    const input = 'Here are the results:\n| Name | Score |\n| --- | --- |\n| Alice | 95 |\nDone!';
    const result = formatForChat(input);
    expect(result).toContain('Here are the results:');
    expect(result).toContain('**Name:** Alice');
    expect(result).toContain('**Score:** 95');
    expect(result).toContain('Done!');
  });

  it('handles alignment markers in separator row', () => {
    const input = '| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | b | c |';
    const result = formatForChat(input);
    expect(result).toContain('**Left:** a');
    expect(result).toContain('**Center:** b');
    expect(result).toContain('**Right:** c');
  });

  it('handles single column table', () => {
    const input = '| Items |\n| --- |\n| Apple |\n| Banana |';
    const result = formatForChat(input);
    expect(result).toContain('**Items:** Apple');
    expect(result).toContain('**Items:** Banana');
  });

  it('handles blank header in the middle', () => {
    const input = '| Name | | Notes |\n| --- | --- | --- |\n| Alpha | x | good |';
    const result = formatForChat(input);
    expect(result).toContain('**Name:** Alpha');
    expect(result).toContain('x');
    expect(result).not.toContain('**:** x');
    expect(result).toContain('**Notes:** good');
  });

  describe('cells with embedded pipes', () => {
    it('treats \\| as a literal pipe inside cell content', () => {
      const input = '| Pattern | Example |\n| --- | --- |\n| or-alt | a \\| b |';
      const result = formatForChat(input);
      expect(result).toContain('**Pattern:** or-alt');
      expect(result).toContain('**Example:** a | b');
      // The \\| should NOT have produced extra orphan cells
      expect(result).not.toMatch(/\n\s*b\s*$/m);
    });

    it('treats pipes inside backtick code spans as literal', () => {
      const input = '| Pass | Code | Output |\n| --- | --- | --- |\n| 1 | `\\| a \\| b \\|` (note) | `**a:** b` |';
      const result = formatForChat(input);
      expect(result).toContain('**Pass:** 1');
      expect(result).toContain('**Code:** `| a | b |` (note)');
      expect(result).toContain('**Output:** `**a:** b`');
      // None of the inner pipes should have leaked out as orphan lines
      expect(result.split('\n').filter(l => l.trim()).length).toBe(3);
    });

    it('regression: 3-col table with backticked sample containing many \\| (the user-reported bug)', () => {
      // This is the exact shape that previously produced 12 cells from a 3-col
      // header → cells beyond index 2 became orphan bare lines.
      const input =
        '| Pass | Matches | Output |\n' +
        '|---|---|---|\n' +
        '| 1 (existing) | `\\| h1 \\| h2 \\|\\n\\| --- \\| --- \\|\\n\\| v1 \\| v2 \\|` (headed) | `**h1:** v1\\n**h2:** v2` |';
      const result = formatForChat(input);
      expect(result).toContain('**Pass:** 1 (existing)');
      expect(result).toContain('**Matches:** `| h1 | h2 |\\n| --- | --- |\\n| v1 | v2 |` (headed)');
      expect(result).toContain('**Output:** `**h1:** v1\\n**h2:** v2`');
      // No orphan bare lines from the previously-fragmented cells
      expect(result).not.toMatch(/^h1 /m);
      expect(result).not.toMatch(/^v2 /m);
    });

    it('bails (leaves the table alone) when a row produces more cells than headers', () => {
      // Force a parser failure mode by making backticks unbalanced — the parser
      // can't tell where the code span ends, so it treats subsequent pipes as
      // delimiters and produces too many cells. Defensive bail-out kicks in.
      const input = '| A | B |\n| --- | --- |\n| `oops | x | y | z |';
      const result = formatForChat(input);
      // Original table should pass through unchanged (no key:value rewrite)
      expect(result).toBe(input);
    });
  });

  describe('header-less 2-column tables', () => {
    it('renders rows as **key:** value', () => {
      const input = '| Name | Alpha |\n| Status | Active |\n| Owner | jdoe |';
      const result = formatForChat(input);
      expect(result).toContain('**Name:** Alpha');
      expect(result).toContain('**Status:** Active');
      expect(result).toContain('**Owner:** jdoe');
      // No leftover pipes from the original table syntax
      expect(result).not.toMatch(/\| Name \|/);
      expect(result).not.toMatch(/\| Status \|/);
    });

    it('keeps surrounding text intact', () => {
      const input = 'Summary:\n| Frame | 426 |\n| Tour | 39.0s |\nDone!';
      const result = formatForChat(input);
      expect(result).toContain('Summary:');
      expect(result).toContain('**Frame:** 426');
      expect(result).toContain('**Tour:** 39.0s');
      expect(result).toContain('Done!');
    });

    it('does NOT rewrite a single isolated 2-cell row (could be prose)', () => {
      const input = 'Pipe in prose: | foo | bar |\nThat was just an example.';
      const result = formatForChat(input);
      // No transformation — single row alone is too ambiguous
      expect(result).toContain('| foo | bar |');
      expect(result).not.toContain('**foo:** bar');
    });

    it('does NOT rewrite tables with 3+ columns and no header', () => {
      const input = '| a | b | c |\n| d | e | f |';
      const result = formatForChat(input);
      expect(result).toBe(input);
    });

    it('does NOT touch a properly headed 2-column table (existing path wins)', () => {
      const input = '| Key | Value |\n| --- | --- |\n| Name | Alpha |\n| Status | Active |';
      const result = formatForChat(input);
      expect(result).toContain('**Key:** Name');
      expect(result).toContain('**Value:** Alpha');
      expect(result).toContain('**Key:** Status');
      // Headed-table path renders header:cell, NOT cell:cell — make sure pass 2
      // doesn't double-transform the output.
      expect(result).not.toContain('**Name:** Alpha');
    });

    it('bails on malformed headed table (separator present, no data rows)', () => {
      // Pass 1 needs ≥ 1 data row, so this doesn't match. Pass 2 must detect
      // the separator and leave the block alone rather than producing
      // "**---:** ---" garbage.
      const input = '| Name | Status |\n| --- | --- |';
      const result = formatForChat(input);
      expect(result).toBe(input);
      expect(result).not.toContain('**---:**');
    });

    it('preserves links in cells', () => {
      const input = '| Repo | [demo-repo](https://example.com) |\n| Branch | main |';
      const result = formatForChat(input);
      expect(result).toContain('**Repo:** [demo-repo](https://example.com)');
      expect(result).toContain('**Branch:** main');
    });
  });

  describe('auto-linkify (tappable in chat apps)', () => {
    it('wraps plain emails as mailto links', () => {
      const result = formatForChat('Email me at foo@bar.com please.');
      expect(result).toBe('Email me at [foo@bar.com](mailto:foo@bar.com) please.');
    });

    it('wraps emails with tags and subdomains', () => {
      const result = formatForChat('Reply jane.doe+spam@example.com or a@b.c.example.org');
      expect(result).toContain('[jane.doe+spam@example.com](mailto:jane.doe+spam@example.com)');
      expect(result).toContain('[a@b.c.example.org](mailto:a@b.c.example.org)');
    });

    it('leaves trailing punctuation outside the email link', () => {
      const result = formatForChat('Send to foo@bar.com.');
      expect(result).toBe('Send to [foo@bar.com](mailto:foo@bar.com).');
    });

    it('wraps international phone numbers as tel: links', () => {
      const result = formatForChat('Call +1-555-123-4567 today');
      expect(result).toBe('Call [+1-555-123-4567](tel:+15551234567) today');
    });

    it('handles phone numbers with spaces and varying country codes', () => {
      const result = formatForChat('Call +44 20 7946 0958 anytime');
      expect(result).toBe('Call [+44 20 7946 0958](tel:+442079460958) anytime');
    });

    it('does not gobble closing paren when phone is in parens', () => {
      const result = formatForChat('Contact: (+1-555-1234567)');
      expect(result).toBe('Contact: ([+1-555-1234567](tel:+15551234567))');
    });

    it('skips bare phone numbers (no + prefix)', () => {
      // Too ambiguous — could be a date, ID, version, etc.
      expect(formatForChat('Call 555-1234')).toBe('Call 555-1234');
      expect(formatForChat('Code 123-456-789')).toBe('Code 123-456-789');
    });

    it('skips short digit runs that look like versions', () => {
      // 4 digits total — below the 8-digit E.164 floor
      expect(formatForChat('Version +1.2.3-4')).toBe('Version +1.2.3-4');
    });

    it('does not double-wrap an already-linked email', () => {
      const input = 'See [admin@x.com](mailto:admin@x.com)';
      expect(formatForChat(input)).toBe(input);
    });

    it('does not touch content inside inline code spans', () => {
      const input = 'Use `foo@bar.com` in config';
      expect(formatForChat(input)).toBe(input);
    });

    it('does not touch content inside fenced code blocks', () => {
      const input = '```\nfoo@bar.com\n+1-555-123-4567\n```';
      expect(formatForChat(input)).toBe(input);
    });

    it('does not wrap plain URLs (clients auto-link them)', () => {
      const input = 'See https://example.com for details';
      expect(formatForChat(input)).toBe(input);
    });
  });
});

describe('timeUntil', () => {
  it('returns "overdue" for a past deadline', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(timeUntil(past)).toBe('overdue');
  });

  it('returns "in Nm" for minutes-away deadline', () => {
    const soon = new Date(Date.now() + 30 * 60_000).toISOString();
    expect(timeUntil(soon)).toBe('in 30m');
  });

  it('returns "in Nh" for hours-away deadline', () => {
    const later = new Date(Date.now() + 5 * 60 * 60_000).toISOString();
    expect(timeUntil(later)).toBe('in 5h');
  });

  it('returns "in Nd" for days-away deadline', () => {
    const future = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString();
    expect(timeUntil(future)).toBe('in 3d');
  });

  it('never auto-decide deadline (year 9999) shows "in Nd"', () => {
    const never = '9999-12-31T23:59:59Z';
    expect(timeUntil(never)).toMatch(/^in \d+d$/);
  });
});

