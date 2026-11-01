import { describe, expect, it } from 'vitest';
import { decodeJsonEnv, loadConfig } from '../src/config.js';

describe('decodeJsonEnv', () => {
  it('passes through raw JSON and decodes base64', () => {
    const json = '{"installed":{"client_id":"x","client_secret":"y"}}';
    expect(decodeJsonEnv(json)).toBe(json);
    expect(decodeJsonEnv(`  ${Buffer.from(json).toString('base64')}  `)).toBe(json);
  });
});

describe('loadConfig', () => {
  it('loads inline credentials and token seed from env', () => {
    const creds = '{"installed":{"client_id":"id","client_secret":"secret"}}';
    const token = '{"type":"authorized_user","client_id":"id","refresh_token":"r"}';
    const cfg = loadConfig({
      GOOGLE_OAUTH_CREDENTIALS_JSON: Buffer.from(creds).toString('base64'),
      GOOGLE_OAUTH_TOKEN_JSON: token,
      GOOGLE_OAUTH_TOKEN_PATH: '/data/token.json',
    });
    expect(cfg.credentialsJson).toBe(creds);
    expect(cfg.tokenSeedJson).toBe(token);
    expect(cfg.tokenPath).toBe('/data/token.json');
  });
});
