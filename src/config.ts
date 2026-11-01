import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/** Resolves to the project root from both `src/` (tsx) and `dist/` (built). */
export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

export interface Config {
  credentialsPath: string;
  tokenPath: string;
  /** Decoded contents of credentials.json when provided via env (raw JSON or base64). */
  credentialsJson?: string;
  /** Decoded token.json seed for first boot when the token file is missing. */
  tokenSeedJson?: string;
}

export const DEFAULT_CREDENTIALS_PATH = join(PROJECT_ROOT, 'secrets', 'credentials.json');
export const DEFAULT_TOKEN_PATH = join(homedir(), '.config', 'google-workspace-mcp', 'token.json');

function resolvePath(value: string): string {
  const expanded = value === '~' || value.startsWith('~/') ? join(homedir(), value.slice(1)) : value;
  return isAbsolute(expanded) ? expanded : resolve(PROJECT_ROOT, expanded);
}

/**
 * Accepts raw JSON (`{...}`) or standard base64 of that JSON.
 * Values that do not start with `{` are treated as base64.
 */
export function decodeJsonEnv(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('{')) return trimmed;
  return Buffer.from(trimmed, 'base64').toString('utf8');
}

/**
 * Loads `<project>/.env` without overriding variables already set by the host.
 * The host's working directory varies, so the path is anchored to the project root.
 */
export function loadDotEnv(env: NodeJS.ProcessEnv = process.env): void {
  const file = join(PROJECT_ROOT, '.env');
  if (!existsSync(file)) return;
  const parsed = parseEnv(readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined && value !== undefined) env[key] = value;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const creds = env.GOOGLE_OAUTH_CREDENTIALS_PATH?.trim();
  const token = env.GOOGLE_OAUTH_TOKEN_PATH?.trim();
  const credentialsJsonRaw = env.GOOGLE_OAUTH_CREDENTIALS_JSON?.trim();
  const tokenSeedRaw = env.GOOGLE_OAUTH_TOKEN_JSON?.trim();
  return {
    credentialsPath: creds ? resolvePath(creds) : DEFAULT_CREDENTIALS_PATH,
    tokenPath: token ? resolvePath(token) : DEFAULT_TOKEN_PATH,
    ...(credentialsJsonRaw ? { credentialsJson: decodeJsonEnv(credentialsJsonRaw) } : {}),
    ...(tokenSeedRaw ? { tokenSeedJson: decodeJsonEnv(tokenSeedRaw) } : {}),
  };
}
