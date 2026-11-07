import { describe, it, expect } from 'vitest';
import { museToolLine } from '../src/muse-events.js';

describe('unmapped Muse tools never render as a bare "{"', () => {
  it('flattens pretty-printed JSON for unknown tools', () => {
    const l = museToolLine('monitor', '{\n  "status": "started",\n  "id": 3\n}', undefined, '/w');
    expect(l?.detail).toBe('{"status":"started","id":3}');
  });
  it('maps bash_input to Bash and hides bookkeeping tools', () => {
    expect(museToolLine('bash_input', '{\n "command": "q"\n}', undefined, '/w')).toEqual({ name: 'Bash', detail: 'q' });
    expect(museToolLine('report_progress', '{\n}', undefined, '/w')).toBeNull();
    expect(museToolLine('work_list', '{\n}', undefined, '/w')).toBeNull();
  });
});
