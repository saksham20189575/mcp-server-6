import mailComposerModule from 'nodemailer/lib/mail-composer';
import type { gmail_v1 } from 'googleapis';
import { mapGoogleError } from './errors.js';
import type { SendEmailInput } from './validation.js';

interface MailComposerOptions {
  to: string;
  subject: string;
  text: string;
  textEncoding: 'base64';
  disableFileAccess: boolean;
  disableUrlAccess: boolean;
}

interface MailComposer {
  compile(): { build(): Promise<Buffer> };
}

type MailComposerConstructor = new (options: MailComposerOptions) => MailComposer;

/**
 * Nodemailer 10 ships separate CJS and ESM declarations for this entry.
 * Vercel's typecheck loads the CJS declaration, which types a default import
 * as the module namespace (`typeof import(...)`) rather than the class. The
 * ESM declaration types the same import as the class. Both builds put the
 * constructor on the value itself; the CJS build also sets `.default`.
 */
function resolveMailComposer(exported: unknown): MailComposerConstructor {
  if (typeof exported === 'function') return exported as MailComposerConstructor;
  if (
    exported !== null &&
    typeof exported === 'object' &&
    'default' in exported &&
    typeof exported.default === 'function'
  ) {
    return exported.default as MailComposerConstructor;
  }
  throw new Error('nodemailer MailComposer export is not constructable');
}

const MailComposer = resolveMailComposer(mailComposerModule);

export interface RequestOptions {
  retry?: boolean;
  timeout?: number;
}

/** The subset of the googleapis Gmail client this module uses (injected for testability). */
export interface GmailApi {
  users: {
    messages: {
      send(
        params: { userId: string; requestBody: { raw: string } },
        options?: RequestOptions,
      ): Promise<{ data: gmail_v1.Schema$Message }>;
    };
  };
}

export interface SendEmailResult {
  messageId: string;
  threadId: string;
}

export const WRITE_TIMEOUT_MS = 30_000;

/**
 * Builds an RFC 5322 UTF-8 plain-text message. No From header is set: Gmail
 * fills it with the authenticated account, so the sender cannot be spoofed.
 */
export async function buildRawMessage(input: SendEmailInput): Promise<string> {
  const mail = new MailComposer({
    to: input.to,
    subject: input.subject,
    text: input.body,
    textEncoding: 'base64',
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const message = await mail.compile().build();
  return message.toString('base64url');
}

export async function sendEmail(gmail: GmailApi, input: SendEmailInput): Promise<SendEmailResult> {
  const raw = await buildRawMessage(input);
  let data: gmail_v1.Schema$Message;
  try {
    // Exactly one attempt: a retried send can deliver duplicate emails.
    ({ data } = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } }, { retry: false, timeout: WRITE_TIMEOUT_MS }));
  } catch (err) {
    throw mapGoogleError(err, 'gmail.send');
  }
  return { messageId: data.id ?? '', threadId: data.threadId ?? '' };
}
