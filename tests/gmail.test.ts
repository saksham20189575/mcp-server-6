import { describe, expect, it, vi } from 'vitest';
import { ToolError } from '../src/errors.js';
import { buildRawMessage, sendEmail, type GmailApi } from '../src/gmail.js';

const input = { to: 'alex@example.com', subject: 'Projekt-Update ✓', body: 'Hi Alex,\n\nThe first milestone is complete.\nÜberall.' };

function mockGmail(impl: () => Promise<unknown>) {
  const send = vi.fn(impl);
  const gmail = { users: { messages: { send } } } as unknown as GmailApi;
  return { gmail, send };
}

function decode(raw: string) {
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const [head = '', ...rest] = text.split('\r\n\r\n');
  const headers = Object.fromEntries(
    head
      .replace(/\r\n[ \t]+/g, ' ')
      .split('\r\n')
      .map((line) => {
        const i = line.indexOf(':');
        return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()];
      }),
  );
  return { headers, body: rest.join('\r\n\r\n') };
}

function decodeMimeWord(value: string): string {
  return value.replace(/=\?UTF-8\?B\?([^?]+)\?=\s*/gi, (_, b64: string) => Buffer.from(b64, 'base64').toString('utf8'));
}

describe('buildRawMessage', () => {
  it('produces a UTF-8 plain-text MIME message without a From header', async () => {
    const { headers, body } = decode(await buildRawMessage(input));
    expect(headers.to).toBe('alex@example.com');
    expect(decodeMimeWord(headers.subject ?? '')).toBe(input.subject);
    expect(headers.from).toBeUndefined();
    expect(headers.bcc).toBeUndefined();
    expect(headers['content-type']).toMatch(/text\/plain; charset=utf-8/i);
    expect(headers['content-transfer-encoding']).toBe('base64');
    expect(Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')).toBe(input.body);
  });

  it('uses base64url encoding (no +, /, or = padding issues for Gmail raw)', async () => {
    const raw = await buildRawMessage(input);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('sendEmail', () => {
  it('sends exactly one request as "me" with retries disabled', async () => {
    const { gmail, send } = mockGmail(async () => ({ data: { id: 'MSG_ID', threadId: 'THREAD_ID' } }));
    const result = await sendEmail(gmail, input);

    expect(result).toEqual({ messageId: 'MSG_ID', threadId: 'THREAD_ID' });
    expect(send).toHaveBeenCalledTimes(1);
    const [params, options] = send.mock.calls[0] as unknown as [{ userId: string; requestBody: { raw: string } }, { retry: boolean }];
    expect(params.userId).toBe('me');
    expect(decode(params.requestBody.raw).headers.to).toBe('alex@example.com');
    expect(options.retry).toBe(false);
  });

  it.each([
    [{ response: { status: 403, data: { error: { message: 'Forbidden', errors: [{ reason: 'forbidden' }] } } } }, 'GMAIL_PERMISSION_DENIED', false],
    [{ response: { status: 403, data: { error: { message: 'x', errors: [{ reason: 'insufficientPermissions' }] } } } }, 'AUTH_SCOPE_MISSING', false],
    [{ response: { status: 403, data: { error: { message: 'Gmail API has not been used', errors: [{ reason: 'accessNotConfigured' }] } } } }, 'GOOGLE_API_DISABLED', false],
    [{ response: { status: 400, data: { error: { message: 'Invalid To header' } } } }, 'GMAIL_INVALID_REQUEST', false],
    [{ response: { status: 401, data: { error: { message: 'Invalid Credentials' } } } }, 'AUTH_EXPIRED', false],
    [{ response: { status: 429, data: { error: { message: 'Too many' } } } }, 'RATE_LIMITED', false],
    [{ response: { status: 503, data: { error: { message: 'Backend error' } } } }, 'GMAIL_SEND_UNCONFIRMED', true],
    [Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'GMAIL_SEND_UNCONFIRMED', true],
    [Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), 'GMAIL_SEND_UNCONFIRMED', true],
    [Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }), 'NETWORK_ERROR', false],
  ])('maps failure %# to %s without retrying', async (error, code, ambiguous) => {
    const { gmail, send } = mockGmail(async () => {
      throw error;
    });
    const err = await sendEmail(gmail, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe(code);
    expect((err as ToolError).ambiguous).toBe(ambiguous);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
