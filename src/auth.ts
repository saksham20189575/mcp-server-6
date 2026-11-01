import { access, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { OAuth2Client, type Credentials } from 'google-auth-library';
import type { Config } from './config.js';
import { mapGoogleError, ToolError } from './errors.js';
import { log } from './logger.js';

export const SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/documents'] as const;

const REAUTH = 'Run `npm run auth` in the google-workspace-mcp directory.';

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface StoredToken {
  type: 'authorized_user';
  client_id: string;
  refresh_token: string;
  scope: string;
  created_at: string;
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

/** Parses Desktop-app OAuth client JSON from a string (file contents or env value). */
export function parseClientCredentials(raw: string, source: string): ClientCredentials {
  let parsed: { installed?: { client_id?: string; client_secret?: string }; web?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ToolError('CONFIG_ERROR', `OAuth client credentials from ${source} are not valid JSON.`);
  }
  if (!parsed.installed) {
    throw new ToolError(
      'CONFIG_ERROR',
      parsed.web
        ? 'The OAuth client is a "Web application" client. Create an OAuth client of type "Desktop app" instead.'
        : `OAuth client credentials from ${source} are not a Desktop app client (missing "installed" section).`,
    );
  }
  const { client_id, client_secret } = parsed.installed;
  if (!client_id || !client_secret) {
    throw new ToolError('CONFIG_ERROR', `OAuth client credentials from ${source} are missing client_id or client_secret.`);
  }
  return { clientId: client_id, clientSecret: client_secret };
}

export async function readClientCredentials(path: string): Promise<ClientCredentials> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isNotFound(err)) {
      throw new ToolError(
        'CONFIG_ERROR',
        `OAuth client file not found at ${path}. Download your Desktop app OAuth client JSON from Google Cloud Console and set GOOGLE_OAUTH_CREDENTIALS_PATH or GOOGLE_OAUTH_CREDENTIALS_JSON (see README).`,
      );
    }
    throw new ToolError('CONFIG_ERROR', `Could not read OAuth client file at ${path}.`, { cause: err });
  }
  return parseClientCredentials(raw, path);
}

export async function loadClientCredentials(config: Config): Promise<ClientCredentials> {
  if (config.credentialsJson) {
    return parseClientCredentials(config.credentialsJson, 'GOOGLE_OAUTH_CREDENTIALS_JSON');
  }
  return readClientCredentials(config.credentialsPath);
}

export async function readToken(path: string): Promise<StoredToken> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isNotFound(err)) {
      throw new ToolError('AUTH_REQUIRED', `No Google authorization found. ${REAUTH} Then try again.`);
    }
    throw new ToolError('CONFIG_ERROR', `Could not read token file at ${path}.`, { cause: err });
  }
  return parseStoredToken(raw, path);
}

/**
 * Loads the refresh token from the token file when present, otherwise from
 * `GOOGLE_OAUTH_TOKEN_JSON` (serverless / Vercel has no durable disk).
 */
export async function loadStoredToken(config: Config): Promise<StoredToken> {
  try {
    return await readToken(config.tokenPath);
  } catch (err) {
    if (err instanceof ToolError && err.code === 'AUTH_REQUIRED' && config.tokenSeedJson) {
      return parseStoredToken(config.tokenSeedJson, 'GOOGLE_OAUTH_TOKEN_JSON');
    }
    throw err;
  }
}

export function parseStoredToken(raw: string, source: string): StoredToken {
  let token: Partial<StoredToken>;
  try {
    token = JSON.parse(raw);
  } catch {
    throw new ToolError('AUTH_REQUIRED', `The token from ${source} is corrupted. ${REAUTH}`);
  }
  if (!token.refresh_token || !token.client_id) {
    throw new ToolError('AUTH_REQUIRED', `The token from ${source} has no refresh token. ${REAUTH}`);
  }
  return {
    type: 'authorized_user',
    client_id: token.client_id,
    refresh_token: token.refresh_token,
    scope: token.scope ?? '',
    created_at: token.created_at ?? new Date().toISOString(),
  };
}

/** Atomically writes the token file with owner-only permissions. */
export async function saveToken(path: string, token: StoredToken): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

/**
 * If `GOOGLE_OAUTH_TOKEN_JSON` is set and the token file does not exist yet,
 * write the seed to disk (0600). An existing file is never overwritten — it
 * remains the source of truth after first boot (including refresh-token rotation).
 */
export async function seedTokenIfMissing(config: Config): Promise<boolean> {
  if (!config.tokenSeedJson) return false;

  try {
    await access(config.tokenPath);
    return false;
  } catch (err) {
    if (!isNotFound(err)) {
      throw new ToolError('CONFIG_ERROR', `Could not check token file at ${config.tokenPath}.`, { cause: err });
    }
  }

  const token = parseStoredToken(config.tokenSeedJson, 'GOOGLE_OAUTH_TOKEN_JSON');
  await saveToken(config.tokenPath, token);
  log.info('auth.token_seeded', { tokenPath: config.tokenPath });
  return true;
}

export function missingScopes(granted: string): string[] {
  const set = new Set(granted.split(/\s+/).filter(Boolean));
  return SCOPES.filter((s) => !set.has(s));
}

/**
 * Lazily builds an authorized OAuth2Client from the stored refresh token.
 * Nothing is cached until loading succeeds, so running `npm run auth` while
 * the server is up takes effect on the next tool call without a restart.
 */
export class AuthManager {
  private client: OAuth2Client | undefined;

  constructor(private readonly config: Config) {}

  async getClient(): Promise<OAuth2Client> {
    if (this.client) return this.client;

    const creds = await loadClientCredentials(this.config);
    const token = await loadStoredToken(this.config);

    if (token.client_id !== creds.clientId) {
      throw new ToolError('AUTH_REQUIRED', `The stored authorization was issued for a different OAuth client. ${REAUTH}`);
    }
    const missing = missingScopes(token.scope);
    if (missing.length > 0) {
      throw new ToolError('AUTH_SCOPE_MISSING', `The stored authorization is missing: ${missing.join(', ')}. ${REAUTH} Grant both requested permissions.`);
    }

    const client = new OAuth2Client({ clientId: creds.clientId, clientSecret: creds.clientSecret });
    client.setCredentials({ refresh_token: token.refresh_token, scope: token.scope });
    client.on('tokens', (tokens: Credentials) => {
      if (!tokens.refresh_token || tokens.refresh_token === token.refresh_token) return;
      token.refresh_token = tokens.refresh_token;
      if (tokens.scope) token.scope = tokens.scope;
      saveToken(this.config.tokenPath, token)
        .then(() => log.info('auth.token_rotated'))
        .catch((err: unknown) => log.error('auth.token_save_failed', { error: err instanceof Error ? err.message : String(err) }));
    });

    this.client = client;
    return client;
  }

  /**
   * Returns a client with a valid access token, refreshing if needed. Doing this
   * before a write ensures auth/network failures are reported as definite
   * failures rather than as an ambiguous write outcome.
   */
  async getAuthorizedClient(): Promise<OAuth2Client> {
    const client = await this.getClient();
    try {
      await client.getAccessToken();
    } catch (err) {
      const mapped = mapGoogleError(err, 'auth.refresh');
      if (mapped.code.startsWith('AUTH_')) this.client = undefined;
      throw mapped;
    }
    return client;
  }
}
