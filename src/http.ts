#!/usr/bin/env node
import { timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { google } from 'googleapis';
import { AuthManager, seedTokenIfMissing } from './auth.js';
import { loadConfig, loadDotEnv } from './config.js';
import type { DocsApi } from './docs.js';
import type { GmailApi } from './gmail.js';
import { log } from './logger.js';
import { createServer, SERVER_VERSION, type GoogleServices } from './server.js';

const MAX_BODY = 1024 * 1024; // 1 MiB
const MIN_AUTH_TOKEN_CHARS = 32;

export function requireAuthToken(value: string | undefined = process.env.MCP_AUTH_TOKEN): Buffer {
  const token = value ?? '';
  if (token.length < MIN_AUTH_TOKEN_CHARS) {
    throw new Error('MCP_AUTH_TOKEN must be set to at least 32 characters');
  }
  return Buffer.from(token);
}

export function isAuthorized(header: string | undefined, expected: Buffer): boolean {
  const presented = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '');
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export interface HttpListenOptions {
  port?: number;
  host?: string;
  authToken: Buffer;
  services: GoogleServices;
}

export interface HttpListenResult {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

/** Starts the Streamable HTTP MCP server (bearer-protected `/mcp` + `/healthz`). */
export function listenHttp(options: HttpListenOptions): Promise<HttpListenResult> {
  const mcp = createMcpHandler(() => createServer(options.services), {
    maxRequestBodySize: MAX_BODY,
    onerror: (err) => log.error('transport.error', { error: err.message }),
  });

  const handleMcp = toNodeHandler(mcp, {
    maxRequestBodySize: MAX_BODY,
    onerror: (err) => log.error('http.adapter_error', { error: err.message }),
  });

  const server = createHttpServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200).end('ok');
      return;
    }
    if (path !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (!isAuthorized(req.headers.authorization, options.authToken)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
      return;
    }
    void handleMcp(req, res);
  });

  const host = options.host ?? '0.0.0.0';
  const port = options.port ?? Number(process.env.PORT ?? 3000);

  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const bound = typeof address === 'object' && address ? address.port : port;
      log.info('server.started', { version: SERVER_VERSION, transport: 'http', port: bound });
      resolveListen({
        server,
        port: bound,
        close: async () => {
          await new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res())));
          await mcp.close();
        },
      });
    });
  });
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<HttpListenResult> {
  loadDotEnv(env);
  let authToken: Buffer;
  try {
    authToken = requireAuthToken(env.MCP_AUTH_TOKEN);
  } catch (err) {
    log.error('server.config_error', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
    throw err; // unreachable; satisfies definite assignment for typecheckers
  }

  const config = loadConfig(env);
  await seedTokenIfMissing(config);

  const auth = new AuthManager(config);
  const services: GoogleServices = {
    async gmail(): Promise<GmailApi> {
      return google.gmail({ version: 'v1', auth: await auth.getAuthorizedClient() });
    },
    async docs(): Promise<DocsApi> {
      return google.docs({ version: 'v1', auth: await auth.getAuthorizedClient() });
    },
  };

  const listening = await listenHttp({
    authToken,
    services,
    port: env.PORT !== undefined ? Number(env.PORT) : undefined,
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void listening.close().finally(() => process.exit(0));
    });
  }

  return listening;
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entry && import.meta.url === entry) {
  process.on('unhandledRejection', (reason) => {
    log.error('process.unhandled_rejection', { error: reason instanceof Error ? reason.message : String(reason) });
  });
  void main();
}
