import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAuthorized, listenHttp, requireAuthToken } from '../src/http.js';
import type { GoogleServices } from '../src/server.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const AUTH_TOKEN = 'a'.repeat(48);

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number;
  result?: { tools?: { name: string }[]; serverInfo?: { name: string } };
  error?: unknown;
}

function mockServices(onCall?: () => void): GoogleServices {
  return {
    gmail: async () => {
      onCall?.();
      throw new Error('gmail should not be called');
    },
    docs: async () => {
      onCall?.();
      throw new Error('docs should not be called');
    },
  };
}

/** Parses a JSON or SSE (`text/event-stream`) MCP HTTP response body into JSON-RPC messages. */
async function readJsonRpc(res: Response): Promise<JsonRpcMessage[]> {
  const text = await res.text();
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/event-stream') || text.startsWith('event:') || text.startsWith('data:')) {
    const messages: JsonRpcMessage[] = [];
    for (const block of text.split('\n\n')) {
      const dataLine = block
        .split('\n')
        .find((line) => line.startsWith('data:'));
      if (!dataLine) continue;
      messages.push(JSON.parse(dataLine.slice(5).trim()) as JsonRpcMessage);
    }
    return messages;
  }
  if (!text.trim()) return [];
  return [JSON.parse(text) as JsonRpcMessage];
}

describe('requireAuthToken / isAuthorized', () => {
  it('rejects missing or short tokens', () => {
    expect(() => requireAuthToken(undefined)).toThrow(/at least 32/);
    expect(() => requireAuthToken('short')).toThrow(/at least 32/);
  });

  it('accepts a correct Bearer token and rejects wrong or missing ones', () => {
    const expected = requireAuthToken(AUTH_TOKEN);
    expect(isAuthorized(`Bearer ${AUTH_TOKEN}`, expected)).toBe(true);
    expect(isAuthorized(`Bearer ${'b'.repeat(48)}`, expected)).toBe(false);
    expect(isAuthorized(undefined, expected)).toBe(false);
    expect(isAuthorized(AUTH_TOKEN, expected)).toBe(false);
  });
});

describe('HTTP MCP server', () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  let serviceCalls = 0;

  beforeAll(async () => {
    const listening = await listenHttp({
      port: 0,
      host: '127.0.0.1',
      authToken: requireAuthToken(AUTH_TOKEN),
      services: mockServices(() => {
        serviceCalls += 1;
      }),
    });
    baseUrl = `http://127.0.0.1:${listening.port}`;
    close = listening.close;
  });

  afterAll(async () => {
    await close();
  });

  it('GET /healthz returns 200 without auth', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('unknown paths return 404', async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });

  it('POST /mcp without Authorization returns 401 and never invokes tools', async () => {
    serviceCalls = 0;
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(serviceCalls).toBe(0);
  });

  it('POST /mcp with a wrong token returns 401', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${'b'.repeat(48)}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('authorized initialize + tools/list returns exactly two tools', async () => {
    const headers = {
      authorization: `Bearer ${AUTH_TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };

    const init = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'http-test', version: '0.0.0' },
        },
      }),
    });
    expect(init.status).toBe(200);
    const [initBody] = await readJsonRpc(init);
    expect(initBody?.error).toBeUndefined();
    expect(initBody?.result?.serverInfo?.name).toBe('google-workspace-mcp');

    const sessionId = init.headers.get('mcp-session-id');
    const listHeaders = sessionId ? { ...headers, 'mcp-session-id': sessionId } : headers;

    await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: listHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });

    const listed = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: listHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(listed.status).toBe(200);
    const [listBody] = await readJsonRpc(listed);
    expect(listBody?.error).toBeUndefined();
    const names = (listBody?.result?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(['append_to_google_doc', 'send_email']);
  });
});

describe('HTTP entry startup', () => {
  it('exits non-zero when MCP_AUTH_TOKEN is missing or short', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gws-mcp-http-'));
    const credentialsPath = join(dir, 'credentials.json');
    await writeFile(credentialsPath, JSON.stringify({ installed: { client_id: 'id', client_secret: 'secret' } }));

    const tsxLoader = pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
    const run = (token: string | undefined) =>
      new Promise<number>((resolve) => {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          GOOGLE_OAUTH_CREDENTIALS_PATH: credentialsPath,
          GOOGLE_OAUTH_TOKEN_PATH: join(dir, 'no-token.json'),
          PORT: '0',
        };
        delete env.MCP_AUTH_TOKEN;
        if (token !== undefined) env.MCP_AUTH_TOKEN = token;

        const child = spawn(process.execPath, ['--import', tsxLoader, join(ROOT, 'src', 'http.ts')], {
          cwd: dir,
          env,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
        const timer = setTimeout(() => child.kill('SIGKILL'), 8_000);
        child.on('exit', (code) => {
          clearTimeout(timer);
          expect(stderr).toContain('MCP_AUTH_TOKEN');
          resolve(code ?? 1);
        });
      });

    try {
      expect(await run(undefined)).not.toBe(0);
      expect(await run('too-short')).not.toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
