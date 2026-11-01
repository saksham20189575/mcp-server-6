import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number;
  result?: { tools?: { name: string; annotations?: Record<string, boolean> }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
  error?: unknown;
}

let dir: string;
let child: ChildProcessWithoutNullStreams;
const stdoutLines: string[] = [];
let stderr = '';
const pending = new Map<number, (msg: JsonRpcMessage) => void>();
let nextId = 1;

function request(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcMessage> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gws-mcp-stdio-'));
  const credentialsPath = join(dir, 'credentials.json');
  await writeFile(credentialsPath, JSON.stringify({ installed: { client_id: 'id', client_secret: 'secret' } }));

  // Run from an unrelated cwd, as MCP hosts do; tsx is therefore referenced by absolute path.
  const tsxLoader = pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  child = spawn(process.execPath, ['--import', tsxLoader, join(ROOT, 'src', 'index.ts')], {
    cwd: dir,
    env: { ...process.env, GOOGLE_OAUTH_CREDENTIALS_PATH: credentialsPath, GOOGLE_OAUTH_TOKEN_PATH: join(dir, 'no-token.json') },
  });

  let buffer = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk;
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      stdoutLines.push(line);
      try {
        const msg = JSON.parse(line) as JsonRpcMessage;
        if (typeof msg.id === 'number') pending.get(msg.id)?.(msg);
      } catch {
        // Non-JSON output is asserted on below.
      }
    }
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));

  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'stdio-test', version: '0.0.0' },
  });
  expect(init.error).toBeUndefined();
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
});

afterAll(async () => {
  child?.kill();
  await rm(dir, { recursive: true, force: true });
});

describe('MCP server over stdio', () => {
  it('lists exactly the two tools, marked as non-read-only and non-idempotent', async () => {
    const res = await request('tools/list');
    const tools = res.result?.tools ?? [];
    expect(tools.map((t) => t.name).sort()).toEqual(['append_to_google_doc', 'send_email']);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(false);
      expect(t.annotations?.idempotentHint).toBe(false);
    }
  });

  it('rejects invalid input with VALIDATION_ERROR', async () => {
    const res = await request('tools/call', {
      name: 'send_email',
      arguments: { to: 'a@b.com\r\nBcc: x@y.com', subject: 'Hi', body: 'secret-body-text' },
    });
    expect(res.result?.isError).toBe(true);
    expect(res.result?.structuredContent?.error).toBe('VALIDATION_ERROR');
  });

  it('returns AUTH_REQUIRED when not yet authorized', async () => {
    const res = await request('tools/call', {
      name: 'append_to_google_doc',
      arguments: { documentId: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', content: 'sensitive-doc-text' },
    });
    expect(res.result?.isError).toBe(true);
    expect(res.result?.structuredContent?.error).toBe('AUTH_REQUIRED');
    expect(res.result?.structuredContent?.success).toBe(false);
  });

  it('writes only JSON-RPC to stdout and keeps logs on stderr without sensitive content', () => {
    expect(stdoutLines.length).toBeGreaterThan(0);
    for (const line of stdoutLines) {
      expect(() => JSON.parse(line)).not.toThrow();
      expect(JSON.parse(line).jsonrpc).toBe('2.0');
    }
    expect(stderr).toContain('server.started');
    expect(stderr).not.toContain('secret-body-text');
    expect(stderr).not.toContain('sensitive-doc-text');
  });
});
