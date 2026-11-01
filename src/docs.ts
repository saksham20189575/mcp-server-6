import type { docs_v1 } from 'googleapis';
import { mapGoogleError } from './errors.js';
import type { AppendDocInput } from './validation.js';

export interface ReadRequestOptions {
  timeout?: number;
  retryConfig?: {
    retry?: number;
    noResponseRetries?: number;
    httpMethodsToRetry?: string[];
    statusCodesToRetry?: number[][];
  };
}

export interface WriteRequestOptions {
  retry?: boolean;
  timeout?: number;
}

/** The subset of the googleapis Docs client this module uses (injected for testability). */
export interface DocsApi {
  documents: {
    get(params: { documentId: string; fields?: string }, options?: ReadRequestOptions): Promise<{ data: docs_v1.Schema$Document }>;
    batchUpdate(
      params: { documentId: string; requestBody: docs_v1.Schema$BatchUpdateDocumentRequest },
      options?: WriteRequestOptions,
    ): Promise<{ data: docs_v1.Schema$BatchUpdateDocumentResponse }>;
  };
}

export interface AppendResult {
  documentId: string;
  documentUrl: string;
}

const TIMEOUT_MS = 30_000;

// Reads are safe to retry; writes are not (a retried append duplicates content).
const READ_OPTIONS: ReadRequestOptions = {
  timeout: TIMEOUT_MS,
  retryConfig: {
    retry: 2,
    noResponseRetries: 2,
    httpMethodsToRetry: ['GET'],
    statusCodesToRetry: [
      [429, 429],
      [500, 599],
    ],
  },
};
const WRITE_OPTIONS: WriteRequestOptions = { retry: false, timeout: TIMEOUT_MS };

const END_FIELDS = 'documentId,body(content(paragraph(elements(textRun(content)))))';

export function documentUrl(documentId: string): string {
  return `https://docs.google.com/document/d/${documentId}/edit`;
}

/** Text of the body's last paragraph including its trailing "\n", or null if the body has no paragraphs. */
export function lastParagraphText(doc: docs_v1.Schema$Document): string | null {
  const content = doc.body?.content ?? [];
  for (let i = content.length - 1; i >= 0; i--) {
    const paragraph = content[i]?.paragraph;
    if (paragraph) {
      return (paragraph.elements ?? []).map((el) => el.textRun?.content ?? '').join('');
    }
    if (content[i]?.table || content[i]?.tableOfContents) return null;
  }
  return null;
}

/**
 * `endOfSegmentLocation` inserts immediately before the body's final newline,
 * i.e. at the end of the last paragraph. Start a new paragraph unless the last
 * paragraph is already empty or the content itself begins with a newline.
 */
export function textToInsert(doc: docs_v1.Schema$Document, content: string): string {
  if (content.startsWith('\n')) return content;
  const last = lastParagraphText(doc);
  const lastIsEmpty = last !== null && last.replace(/\n$/, '').length === 0;
  return lastIsEmpty ? content : `\n${content}`;
}

export async function appendToDoc(docs: DocsApi, input: AppendDocInput): Promise<AppendResult> {
  const { documentId, content } = input;

  // Without includeTabsContent, `body` is the first tab's body, which is also
  // where endOfSegmentLocation (no tabId) inserts.
  let doc: docs_v1.Schema$Document;
  try {
    ({ data: doc } = await docs.documents.get({ documentId, fields: END_FIELDS }, READ_OPTIONS));
  } catch (err) {
    throw mapGoogleError(err, 'docs.get');
  }

  const text = textToInsert(doc, content);
  try {
    await docs.documents.batchUpdate(
      {
        documentId,
        requestBody: { requests: [{ insertText: { endOfSegmentLocation: { segmentId: '' }, text } }] },
      },
      WRITE_OPTIONS,
    );
  } catch (err) {
    throw mapGoogleError(err, 'docs.batchUpdate');
  }

  return { documentId, documentUrl: documentUrl(documentId) };
}
