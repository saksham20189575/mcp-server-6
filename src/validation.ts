import { z } from 'zod';
import { ToolError } from './errors.js';

export const LIMITS = {
  emailAddress: 254,
  subject: 255,
  body: 100_000,
  content: 100_000,
} as const;

const CR_OR_LF = /[\r\n]/;
// Characters that would turn a single address into a list or a display-name form.
const ADDRESS_FORBIDDEN = /[\s,;<>"'()\\]/;
// Control characters other than tab (\t) and newline (\n).
// eslint-disable-next-line no-control-regex
const DISALLOWED_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const DOC_ID = /^[A-Za-z0-9_-]{20,128}$/;
const DOC_PATH = /^\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,128})(?:\/|$)/;

const normalizeNewlines = (s: string) => s.replace(/\r\n?/g, '\n');

const plainText = (field: string, max: number) =>
  z
    .string()
    .transform(normalizeNewlines)
    .pipe(
      z
        .string()
        .refine((v) => v.trim().length > 0, `${field} must not be empty`)
        .refine((v) => v.length <= max, `${field} must be at most ${max} characters`)
        .refine((v) => !DISALLOWED_CONTROL.test(v), `${field} contains unsupported control characters`),
    );

/** Accepts a bare Google Docs ID or a docs.google.com/document/d/<ID>/... URL. Returns null if invalid. */
export function extractDocumentId(input: string): string | null {
  const value = input.trim();
  if (DOC_ID.test(value)) return value;

  const candidate = /^docs\.google\.com\//i.test(value) ? `https://${value}` : value;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || url.username || url.password) return null;
  const match = DOC_PATH.exec(url.pathname);
  return match?.[1] ?? null;
}

export const SendEmailInput = z.object({
  to: z
    .string()
    .trim()
    .min(1, 'to must not be empty')
    .max(LIMITS.emailAddress, `to must be at most ${LIMITS.emailAddress} characters`)
    .refine((v) => !CR_OR_LF.test(v), 'to must not contain line breaks')
    .refine((v) => !ADDRESS_FORBIDDEN.test(v), 'to must be exactly one plain email address (no names, lists, or separators)')
    .pipe(z.email('to must be a valid email address')),
  subject: z
    .string()
    .refine((v) => !CR_OR_LF.test(v), 'subject must not contain line breaks')
    .refine((v) => !DISALLOWED_CONTROL.test(v), 'subject contains unsupported control characters')
    .transform((v) => v.trim())
    .pipe(
      z
        .string()
        .min(1, 'subject must not be empty')
        .max(LIMITS.subject, `subject must be at most ${LIMITS.subject} characters`),
    ),
  body: plainText('body', LIMITS.body),
});
export type SendEmailInput = z.infer<typeof SendEmailInput>;

export const AppendDocInput = z.object({
  documentId: z.string().transform((value, ctx) => {
    const id = extractDocumentId(value);
    if (!id) {
      ctx.addIssue({
        code: 'custom',
        message: 'documentId must be a Google Docs document ID or a https://docs.google.com/document/d/<ID>/... URL',
      });
      return z.NEVER;
    }
    return id;
  }),
  content: plainText('content', LIMITS.content),
});
export type AppendDocInput = z.infer<typeof AppendDocInput>;

export function parseInput<S extends z.ZodType>(schema: S, args: unknown): z.infer<S> {
  const result = schema.safeParse(args);
  if (result.success) return result.data;
  const message = result.error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
  throw new ToolError('VALIDATION_ERROR', `Invalid input. ${message}`);
}
