import { describe, expect, it, vi } from 'vitest';
import type { docs_v1 } from 'googleapis';
import { appendToDoc, textToInsert, type DocsApi } from '../src/docs.js';
import { ToolError } from '../src/errors.js';

const DOC_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc';

function doc(...paragraphs: string[]): docs_v1.Schema$Document {
  return {
    documentId: DOC_ID,
    body: {
      content: [{ sectionBreak: {} }, ...paragraphs.map((p) => ({ paragraph: { elements: [{ textRun: { content: p } }] } }))],
    },
  };
}

function mockDocs(document: docs_v1.Schema$Document, batchUpdateImpl: () => Promise<unknown> = async () => ({ data: {} })) {
  const get = vi.fn(async () => ({ data: document }));
  const batchUpdate = vi.fn(batchUpdateImpl);
  const docs = { documents: { get, batchUpdate } } as unknown as DocsApi;
  return { docs, get, batchUpdate };
}

describe('textToInsert', () => {
  it('does not add a leading newline to an empty document', () => {
    expect(textToInsert(doc('\n'), 'Hello')).toBe('Hello');
  });

  it('starts a new paragraph after existing text', () => {
    expect(textToInsert(doc('Original content\n'), 'Appended')).toBe('\nAppended');
  });

  it('does not double-separate when the last paragraph is already empty', () => {
    expect(textToInsert(doc('Original content\n', '\n'), 'Appended')).toBe('Appended');
  });

  it('respects content that already starts with a newline', () => {
    expect(textToInsert(doc('Original content\n'), '\nAppended content')).toBe('\nAppended content');
  });

  it('handles a last paragraph split across multiple text runs', () => {
    const d: docs_v1.Schema$Document = {
      body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Bold' } }, { textRun: { content: ' plain\n' } }] } }] },
    };
    expect(textToInsert(d, 'x')).toBe('\nx');
  });

  it('treats a missing body as empty', () => {
    expect(textToInsert({}, 'x')).toBe('\nx');
    expect(textToInsert({ body: { content: [{ paragraph: { elements: [] } }] } }, 'x')).toBe('x');
  });
});

describe('appendToDoc', () => {
  it('reads the document then sends exactly one insertText at the end of the body', async () => {
    const { docs, get, batchUpdate } = mockDocs(doc('Original content\n'));
    const result = await appendToDoc(docs, { documentId: DOC_ID, content: 'Weekly update\nCompleted.' });

    expect(result).toEqual({ documentId: DOC_ID, documentUrl: `https://docs.google.com/document/d/${DOC_ID}/edit` });
    expect(get).toHaveBeenCalledTimes(1);
    expect(batchUpdate).toHaveBeenCalledTimes(1);

    const [params, options] = batchUpdate.mock.calls[0] as unknown as [
      { documentId: string; requestBody: docs_v1.Schema$BatchUpdateDocumentRequest },
      { retry: boolean },
    ];
    expect(params.documentId).toBe(DOC_ID);
    expect(params.requestBody.requests).toEqual([
      { insertText: { endOfSegmentLocation: { segmentId: '' }, text: '\nWeekly update\nCompleted.' } },
    ]);
    expect(options.retry).toBe(false);
  });

  it('never deletes or replaces content', async () => {
    const { docs, batchUpdate } = mockDocs(doc('Original content\n'));
    await appendToDoc(docs, { documentId: DOC_ID, content: 'x' });
    const requests = (batchUpdate.mock.calls[0] as unknown as [{ requestBody: docs_v1.Schema$BatchUpdateDocumentRequest }])[0].requestBody.requests ?? [];
    for (const r of requests) {
      expect(Object.keys(r)).toEqual(['insertText']);
    }
  });

  it.each([
    [404, 'DOC_NOT_FOUND'],
    [403, 'DOC_PERMISSION_DENIED'],
  ])('maps a %i on read to %s and does not write', async (status, code) => {
    const get = vi.fn(async () => {
      throw { response: { status, data: { error: { message: 'nope' } } } };
    });
    const batchUpdate = vi.fn();
    const docs = { documents: { get, batchUpdate } } as unknown as DocsApi;

    const err = await appendToDoc(docs, { documentId: DOC_ID, content: 'x' }).catch((e: unknown) => e);
    expect((err as ToolError).code).toBe(code);
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it.each([
    [{ response: { status: 403, data: { error: { message: 'The caller does not have permission' } } } }, 'DOC_PERMISSION_DENIED', false],
    [{ response: { status: 429, data: { error: { message: 'quota' } } } }, 'RATE_LIMITED', false],
    [{ response: { status: 500, data: { error: { message: 'internal' } } } }, 'DOCS_APPEND_UNCONFIRMED', true],
    [Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'DOCS_APPEND_UNCONFIRMED', true],
  ])('maps write failure %# to %s without retrying', async (error, code, ambiguous) => {
    const { docs, batchUpdate } = mockDocs(doc('Original\n'), async () => {
      throw error;
    });
    const err = await appendToDoc(docs, { documentId: DOC_ID, content: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe(code);
    expect((err as ToolError).ambiguous).toBe(ambiguous);
    expect(batchUpdate).toHaveBeenCalledTimes(1);
  });
});
