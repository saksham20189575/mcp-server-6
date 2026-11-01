import { describe, expect, it } from 'vitest';
import { maskEmail, redact } from '../src/logger.js';

describe('redact', () => {
  it('removes Google tokens, auth codes, and secrets', () => {
    const line = JSON.stringify({
      a: 'ya29.a0AfH6SMBxyz-123',
      b: '1//0gAbCdEfGhIjKlMnOpQrStUvWxYz',
      c: '4/0AX4XfWhAbCdEfGhIjKlMnOpQrStUv',
      refresh_token: 'anything',
      client_secret: 'GOCSPX-secret',
    });
    const out = redact(line);
    for (const secret of ['ya29.', '1//0g', '4/0AX4', 'anything', 'GOCSPX']) {
      expect(out).not.toContain(secret);
    }
  });

  it('keeps ordinary fields such as error codes intact', () => {
    const line = JSON.stringify({ event: 'tool.failure', code: 'CONFIG_ERROR', ms: 3 });
    expect(redact(line)).toBe(line);
  });
});

describe('maskEmail', () => {
  it('masks the local part', () => {
    expect(maskEmail('alex@example.com')).toBe('a***@example.com');
    expect(maskEmail('nope')).toBe('***');
  });
});
