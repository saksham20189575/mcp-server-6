/**
 * Shared Hono MCP app factory (Vercel entry + tests).
 * Vercel loads `src/app.ts`, which default-exports `createApp()`.
 */
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { google } from 'googleapis';
import type { Context } from 'hono';
import { AuthManager, seedTokenIfMissing } from './auth.js';
import { loadConfig, loadDotEnv } from './config.js';
import type { DocsApi } from './docs.js';
import type { GmailApi } from './gmail.js';
import { isAuthorized, requireAuthToken } from './http.js';
import { log } from './logger.js';
import { createServer, SERVER_VERSION, type GoogleServices } from './server.js';

const MAX_BODY = 1024 * 1024; // 1 MiB

/** Strip scheme/path/port → hostname for Host header allow-lists (port-agnostic). */
function toHostname(value: string): string | undefined {
  const hostPort = value.trim().replace(/^https?:\/\//i, '').split('/')[0];
  if (!hostPort) return undefined;
  if (hostPort.startsWith('[')) {
    const end = hostPort.indexOf(']');
    return end === -1 ? hostPort : hostPort.slice(0, end + 1);
  }
  return hostPort.split(':')[0] || undefined;
}

/** Hostnames Vercel sets automatically, plus optional `MCP_ALLOWED_HOSTS` (comma-separated). */
export function resolveAllowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const hosts = new Set<string>();
  for (const key of ['VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL'] as const) {
    const host = env[key]?.trim() ? toHostname(env[key]!) : undefined;
    if (host) hosts.add(host);
  }
  for (const part of (env.MCP_ALLOWED_HOSTS ?? '').split(',')) {
    const host = toHostname(part);
    if (host) hosts.add(host);
  }
  return [...hosts];
}

export interface CreateAppOptions {
  env?: NodeJS.ProcessEnv;
  services?: GoogleServices;
  authToken?: Buffer;
}

/** Builds the Hono MCP app (bearer-protected `/mcp` + open `/healthz`). */
export function createApp(options: CreateAppOptions = {}) {
  const env = options.env ?? process.env;
  loadDotEnv(env);

  // Serverless has no persistent disk; keep a writable path for opportunistic seeding.
  if (env.VERCEL && !env.GOOGLE_OAUTH_TOKEN_PATH?.trim()) {
    env.GOOGLE_OAUTH_TOKEN_PATH = '/tmp/google-workspace-mcp-token.json';
  }

  const authToken = options.authToken ?? requireAuthToken(env.MCP_AUTH_TOKEN);
  const config = loadConfig(env);

  const services =
    options.services ??
    (() => {
      const auth = new AuthManager(config);
      const built: GoogleServices = {
        async gmail(): Promise<GmailApi> {
          return google.gmail({ version: 'v1', auth: await auth.getAuthorizedClient() });
        },
        async docs(): Promise<DocsApi> {
          return google.docs({ version: 'v1', auth: await auth.getAuthorizedClient() });
        },
      };
      return built;
    })();

  // Best-effort seed to /tmp (or configured path). AuthManager also reads the env seed directly.
  void seedTokenIfMissing(config).catch((err: unknown) => {
    log.warn('auth.token_seed_skipped', { error: err instanceof Error ? err.message : String(err) });
  });

  const mcp = createMcpHandler(() => createServer(services), {
    maxRequestBodySize: MAX_BODY,
    onerror: (err) => log.error('transport.error', { error: err.message }),
  });

  const onVercel = Boolean(env.VERCEL);
  const allowedHosts = resolveAllowedHosts(env);
  const app = createMcpHonoApp({
    host: onVercel || allowedHosts.length > 0 ? '0.0.0.0' : '127.0.0.1',
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    maxRequestBodySize: MAX_BODY,
  });

  app.get('/healthz', (c) => c.text('ok'));

  app.all('/mcp', async (c: Context) => {
    if (!isAuthorized(c.req.header('authorization'), authToken)) {
      return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
    }
    return mcp.fetch(c.req.raw, { parsedBody: c.get('parsedBody') });
  });

  log.info('server.started', {
    version: SERVER_VERSION,
    transport: 'http',
    runtime: onVercel ? 'vercel' : 'hono',
  });

  return app;
}
