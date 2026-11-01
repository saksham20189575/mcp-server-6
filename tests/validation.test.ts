import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/errors.js';
import { AppendDocInput, extractDocumentId, LIMITS, parseInput, SendEmailInput } from '../src/validation.js';

const DOC_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc';

function expectValidationError(fn: () => unknown, fragment: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe('VALIDATION_ERROR');
    expect((err as ToolError).message).toContain(fragment);
    return;
  }
  throw new Error('expected a VALIDATION_ERROR');
}

describe('SendEmailInput', () => {
  const valid = { to: 'alex@example.com', subject: 'Project update', body: 'Hi Alex,\n\nDone.' };

  it('accepts valid input and preserves body line breaks', () => {
    const parsed = parseInput(SendEmailInput, valid);
    expect(parsed).toEqual(valid);
  });

  it('trims the recipient and subject, normalizes CRLF in body', () => {
    const parsed = parseInput(SendEmailInput, { to: '  alex@example.com ', subject: ' Hi ', body: 'a\r\nb' });
    expect(parsed).toEqual({ to: 'alex@example.com', subject: 'Hi', body: 'a\nb' });
  });

  it.each([
    ['not-an-email', 'valid email'],
    ['a@b.com, c@d.com', 'exactly one'],
    ['a@b.com;c@d.com', 'exactly one'],
    ['Alex <alex@example.com>', 'exactly one'],
    ['a@b.com\r\nBcc: evil@x.com', 'line breaks'],
    ['', 'must not be empty'],
  ])('rejects recipient %j', (to, fragment) => {
    expectValidationError(() => parseInput(SendEmailInput, { ...valid, to }), fragment);
  });

  it('rejects header injection in subject', () => {
    expectValidationError(() => parseInput(SendEmailInput, { ...valid, subject: 'Hi\r\nBcc: evil@x.com' }), 'line breaks');
    expectValidationError(() => parseInput(SendEmailInput, { ...valid, subject: 'Hi\nBcc: evil@x.com' }), 'line breaks');
  });

  it('rejects empty subject and body', () => {
    expectValidationError(() => parseInput(SendEmailInput, { ...valid, subject: '   ' }), 'subject must not be empty');
    expectValidationError(() => parseInput(SendEmailInput, { ...valid, body: ' \n ' }), 'body must not be empty');
  });

  it('rejects oversized inputs', () => {
    expectValidationError(() => parseInput(SendEmailInput, { ...valid, subject: 'x'.repeat(LIMITS.subject + 1) }), 'at most');
    expectValidationError(() => parseInput(SendEmailInput, { ...valid, body: 'x'.repeat(LIMITS.body + 1) }), 'at most');
  });

  it('rejects missing fields', () => {
    expectValidationError(() => parseInput(SendEmailInput, { to: 'alex@example.com' }), 'subject');
  });
});

describe('extractDocumentId', () => {
  it.each([
    [DOC_ID, DOC_ID],
    [`https://docs.google.com/document/d/${DOC_ID}/edit`, DOC_ID],
    [`https://docs.google.com/document/d/${DOC_ID}/edit?tab=t.0#heading=h.1`, DOC_ID],
    [`https://docs.google.com/document/d/${DOC_ID}`, DOC_ID],
    [`https://docs.google.com/document/u/1/d/${DOC_ID}/edit`, DOC_ID],
    [`docs.google.com/document/d/${DOC_ID}/edit`, DOC_ID],
    [`  ${DOC_ID}  `, DOC_ID],
  ])('extracts from %s', (input, expected) => {
    expect(extractDocumentId(input)).toBe(expected);
  });

  it.each([
    'short',
    `http://docs.google.com/document/d/${DOC_ID}/edit`,
    `https://evil.com/document/d/${DOC_ID}/edit`,
    `https://docs.google.com.evil.com/document/d/${DOC_ID}/edit`,
    `https://docs.google.com/spreadsheets/d/${DOC_ID}/edit`,
    `https://user:pass@docs.google.com/document/d/${DOC_ID}/edit`,
    `javascript:alert(1)`,
    `${DOC_ID}/../x`,
    '',
  ])('rejects %s', (input) => {
    expect(extractDocumentId(input)).toBeNull();
  });
});

describe('AppendDocInput', () => {
  it('extracts the ID from a URL and keeps content line breaks', () => {
    const parsed = parseInput(AppendDocInput, {
      documentId: `https://docs.google.com/document/d/${DOC_ID}/edit`,
      content: '### Weekly update\nCompleted.',
    });
    expect(parsed).toEqual({ documentId: DOC_ID, content: '### Weekly update\nCompleted.' });
  });

  it('rejects invalid document identifiers and empty content', () => {
    expectValidationError(() => parseInput(AppendDocInput, { documentId: 'https://example.com/x', content: 'x' }), 'documentId');
    expectValidationError(() => parseInput(AppendDocInput, { documentId: DOC_ID, content: '' }), 'content must not be empty');
  });

  it('rejects control characters', () => {
    expectValidationError(() => parseInput(AppendDocInput, { documentId: DOC_ID, content: 'a\u0000b' }), 'control characters');
  });
});
