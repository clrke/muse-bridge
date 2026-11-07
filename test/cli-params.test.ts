import { describe, it, expect } from 'vitest';
import { describeCliArgs } from '../src/session-manager.js';

describe('describeCliArgs', () => {
  it('hides the prompt file and shortens the session id', () => {
    const args = ['exec', '--json', '--yolo', '--trust-workspace', '--workspace', '/w', '--session-id', '0123456789abcdef',
      '--prompt-file', '/tmp/muse-prompt-x.txt', '--reasoning-effort', 'high'];
    expect(describeCliArgs('/home/u/.local/bin/muse', args)).toBe(
      'muse exec --json --yolo --trust-workspace --workspace /w --session-id 01234567 --prompt-file <prompt> --reasoning-effort high');
  });
  it('flags a new session', () => {
    expect(describeCliArgs('muse', ['exec', '--session-id', 'abc'], true)).toBe('muse exec --session-id abc (new session)');
  });
});
