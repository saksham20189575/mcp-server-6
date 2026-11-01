import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createApp, resolveAllowedHosts } from '../src/create-app.js';
import { requireAuthToken } from '../src/http.js';
import type { GoogleServices } from '../src/server.js';

const AUTH_TOKEN = 'a'.repeat(48);

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

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number;
  result?: { tools?: { name: string }[]; serverInfo?: { name: string } };
  error?: unknown;
}

async function readJsonRpc(res: Response): Promise<JsonRpcMessage[]> {
  const text = await res.text();
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/event-stream') || text.startsWith('event:') || text.startsWith('data:')) {
    const messages: JsonRpcMessage[] = [];
    for (const block of text.split('\n\n')) {
      const dataLine = block.split('\n').find((line) => line.startsWith('data:'));
      if (!dataLine) continue;
      messages.push(JSON.parse(dataLine.slice(5).trim()) as JsonRpcMessage);
    }
    return messages;
  }
  if (!text.trim()) return [];
  return [JSON.parse(text) as JsonRpcMessage];
}

/** Same check as `@vercel/hono`: the entry file source must import the `hono` package. */
const VERCEL_HONO_ENTRY =
  /(?:from|require|import)\s*(?:\(\s*)?["']hono["']\s*(?:\))?/;

describe('Vercel Hono entrypoint', () => {
  it('src/app.ts imports hono so the framework preset can find it', () => {
    const source = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
    expect(source).toMatch(VERCEL_HONO_ENTRY);
  });
});

describe('resolveAllowedHosts', () => {
  it('collects Vercel URLs and MCP_ALLOWED_HOSTS', () => {
    expect(
      resolveAllowedHosts({
        VERCEL_URL: 'https://my-app-git-main-user.vercel.app',
        VERCEL_PROJECT_PRODUCTION_URL: 'my-app.vercel.app:443',
        MCP_ALLOWED_HOSTS: 'mcp.example.com, https://other.example.com/path',
      }).sort(),
    ).toEqual(['mcp.example.com', 'my-app-git-main-user.vercel.app', 'my-app.vercel.app', 'other.example.com']);
  });
});

describe('Hono MCP app (Vercel entry)', () => {
  const app = createApp({
    authToken: requireAuthToken(AUTH_TOKEN),
    services: mockServices(),
    env: {
      VERCEL: '1',
      VERCEL_URL: 'localhost:3000',
      MCP_AUTH_TOKEN: AUTH_TOKEN,
    },
  });

  it('GET /healthz returns 200 without auth', async () => {
    const res = await app.request('http://localhost:3000/healthz', {
      headers: { host: 'localhost:3000' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('POST /mcp without Authorization returns 401', async () => {
    const res = await app.request('http://localhost:3000/mcp', {
      method: 'POST',
      headers: {
        host: 'localhost:3000',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('authorized initialize returns server info', async () => {
    const res = await app.request('http://localhost:3000/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: 'localhost:3000',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'app-test', version: '0.0.0' },
        },
      }),
    });
    expect(res.status).toBe(200);
    const [body] = await readJsonRpc(res);
    expect(body?.error).toBeUndefined();
    expect(body?.result?.serverInfo?.name).toBe('google-workspace-mcp');
  });
});
