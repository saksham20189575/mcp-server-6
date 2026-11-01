import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuth2Client } from 'google-auth-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthManager,
  loadStoredToken,
  parseClientCredentials,
  readClientCredentials,
  saveToken,
  SCOPES,
  seedTokenIfMissing,
  type StoredToken,
} from '../src/auth.js';
import { decodeJsonEnv } from '../src/config.js';
import { ToolError } from '../src/errors.js';

let dir: string;
let credentialsPath: string;
let tokenPath: string;

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const token = (overrides: Partial<StoredToken> = {}): StoredToken => ({
  type: 'authorized_user',
  client_id: CLIENT_ID,
  refresh_token: 'refresh-1',
  scope: SCOPES.join(' '),
  created_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ToolError);
  return (err as ToolError).code;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gws-mcp-'));
  credentialsPath = join(dir, 'credentials.json');
  tokenPath = join(dir, 'nested', 'token.json');
  await writeFile(credentialsPath, JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: 'secret' } }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('readClientCredentials / parseClientCredentials', () => {
  it('reads a Desktop app client', async () => {
    expect(await readClientCredentials(credentialsPath)).toEqual({ clientId: CLIENT_ID, clientSecret: 'secret' });
  });

  it('parses credentials from a JSON string and from base64', () => {
    const json = JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: 'secret' } });
    expect(parseClientCredentials(json, 'env')).toEqual({ clientId: CLIENT_ID, clientSecret: 'secret' });
    expect(parseClientCredentials(decodeJsonEnv(Buffer.from(json).toString('base64')), 'env')).toEqual({
      clientId: CLIENT_ID,
      clientSecret: 'secret',
    });
  });

  it('rejects a missing file and a web client with CONFIG_ERROR', async () => {
    expect(await codeOf(readClientCredentials(join(dir, 'missing.json')))).toBe('CONFIG_ERROR');
    await writeFile(credentialsPath, JSON.stringify({ web: { client_id: 'x', client_secret: 'y' } }));
    expect(await codeOf(readClientCredentials(credentialsPath))).toBe('CONFIG_ERROR');
  });
});

describe('loadStoredToken', () => {
  it('reads from the token file when present', async () => {
    await saveToken(tokenPath, token());
    const loaded = await loadStoredToken({ credentialsPath, tokenPath });
    expect(loaded.refresh_token).toBe('refresh-1');
  });

  it('falls back to GOOGLE_OAUTH_TOKEN_JSON when the file is missing', async () => {
    const loaded = await loadStoredToken({
      credentialsPath,
      tokenPath,
      tokenSeedJson: JSON.stringify(token({ refresh_token: 'from-env' })),
    });
    expect(loaded.refresh_token).toBe('from-env');
  });

  it('returns AUTH_REQUIRED when neither file nor seed exists', async () => {
    expect(await codeOf(loadStoredToken({ credentialsPath, tokenPath }))).toBe('AUTH_REQUIRED');
  });
});

describe('seedTokenIfMissing', () => {
  it('writes a seeded token with 0600 permissions when the file is missing', async () => {
    const seeded = await seedTokenIfMissing({
      credentialsPath,
      tokenPath,
      tokenSeedJson: JSON.stringify(token()),
    });
    expect(seeded).toBe(true);
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(tokenPath, 'utf8')).refresh_token).toBe('refresh-1');
  });

  it('does not overwrite an existing token file', async () => {
    await saveToken(tokenPath, token({ refresh_token: 'existing' }));
    const seeded = await seedTokenIfMissing({
      credentialsPath,
      tokenPath,
      tokenSeedJson: JSON.stringify(token({ refresh_token: 'from-seed' })),
    });
    expect(seeded).toBe(false);
    expect(JSON.parse(await readFile(tokenPath, 'utf8')).refresh_token).toBe('existing');
  });

  it('is a no-op when no seed is provided', async () => {
    const seeded = await seedTokenIfMissing({ credentialsPath, tokenPath });
    expect(seeded).toBe(false);
    await expect(access(tokenPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('saveToken', () => {
  it('writes the token with 0600 permissions in a 0700 directory', async () => {
    await saveToken(tokenPath, token());
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'nested'))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(tokenPath, 'utf8')).refresh_token).toBe('refresh-1');
  });
});

describe('AuthManager', () => {
  it('returns AUTH_REQUIRED when no token exists', async () => {
    const auth = new AuthManager({ credentialsPath, tokenPath });
    expect(await codeOf(auth.getAuthorizedClient())).toBe('AUTH_REQUIRED');
  });

  it('returns AUTH_SCOPE_MISSING when a scope was not granted', async () => {
    await saveToken(tokenPath, token({ scope: SCOPES[0] }));
    const auth = new AuthManager({ credentialsPath, tokenPath });
    expect(await codeOf(auth.getAuthorizedClient())).toBe('AUTH_SCOPE_MISSING');
  });

  it('returns AUTH_REQUIRED when the token belongs to another OAuth client', async () => {
    await saveToken(tokenPath, token({ client_id: 'other' }));
    const auth = new AuthManager({ credentialsPath, tokenPath });
    expect(await codeOf(auth.getAuthorizedClient())).toBe('AUTH_REQUIRED');
  });

  it('refreshes the access token before returning the client', async () => {
    await saveToken(tokenPath, token());
    const spy = vi.spyOn(OAuth2Client.prototype, 'getAccessToken').mockResolvedValue({ token: 'access', res: null } as never);
    const auth = new AuthManager({ credentialsPath, tokenPath });
    const client = await auth.getAuthorizedClient();
    expect(client.credentials.refresh_token).toBe('refresh-1');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('maps invalid_grant (revoked/expired) to AUTH_EXPIRED and re-reads the token next time', async () => {
    await saveToken(tokenPath, token());
    const spy = vi
      .spyOn(OAuth2Client.prototype, 'getAccessToken')
      .mockRejectedValueOnce({ message: 'invalid_grant', response: { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } } })
      .mockResolvedValueOnce({ token: 'access', res: null } as never);
    const auth = new AuthManager({ credentialsPath, tokenPath });

    expect(await codeOf(auth.getAuthorizedClient())).toBe('AUTH_EXPIRED');
    await saveToken(tokenPath, token({ refresh_token: 'refresh-2' }));
    const client = await auth.getAuthorizedClient();
    expect(client.credentials.refresh_token).toBe('refresh-2');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('maps a network failure during refresh to NETWORK_ERROR (not ambiguous)', async () => {
    await saveToken(tokenPath, token());
    vi.spyOn(OAuth2Client.prototype, 'getAccessToken').mockRejectedValue(Object.assign(new Error('x'), { code: 'ECONNRESET' }));
    const auth = new AuthManager({ credentialsPath, tokenPath });
    const err = (await auth.getAuthorizedClient().catch((e: unknown) => e)) as ToolError;
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.ambiguous).toBe(false);
  });

  it('persists a rotated refresh token', async () => {
    await saveToken(tokenPath, token());
    vi.spyOn(OAuth2Client.prototype, 'getAccessToken').mockResolvedValue({ token: 'access', res: null } as never);
    const auth = new AuthManager({ credentialsPath, tokenPath });
    const client = await auth.getAuthorizedClient();

    client.emit('tokens', { refresh_token: 'refresh-rotated', access_token: 'should-not-be-stored' });
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(tokenPath, 'utf8')).refresh_token).toBe('refresh-rotated');
    });
    const saved = await readFile(tokenPath, 'utf8');
    expect(saved).not.toContain('should-not-be-stored');
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
  });
});
