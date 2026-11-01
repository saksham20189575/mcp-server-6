export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'CONFIG_ERROR'
  | 'AUTH_REQUIRED'
  | 'AUTH_EXPIRED'
  | 'AUTH_SCOPE_MISSING'
  | 'AUTH_POLICY_BLOCKED'
  | 'GOOGLE_API_DISABLED'
  | 'GMAIL_PERMISSION_DENIED'
  | 'GMAIL_INVALID_REQUEST'
  | 'DOC_NOT_FOUND'
  | 'DOC_PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'NETWORK_ERROR'
  | 'GMAIL_SEND_UNCONFIRMED'
  | 'DOCS_APPEND_UNCONFIRMED'
  | 'GOOGLE_API_ERROR'
  | 'INTERNAL_ERROR';

export class ToolError extends Error {
  readonly code: ErrorCode;
  /** The write may have been applied; the caller must not blindly retry. */
  readonly ambiguous: boolean;

  constructor(code: ErrorCode, message: string, options: { ambiguous?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'ToolError';
    this.code = code;
    this.ambiguous = options.ambiguous ?? false;
  }
}

export type GoogleOperation = 'auth.refresh' | 'gmail.send' | 'docs.get' | 'docs.batchUpdate';

const REAUTH_HINT = 'Run `npm run auth` in the google-workspace-mcp directory to reconnect your Google account.';

// Network failures that happen before any bytes reach Google, so a write cannot have been applied.
const PRE_CONNECT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']);

interface GoogleErrorShape {
  status?: number;
  code?: string | number;
  message?: string;
  response?: {
    status?: number;
    data?: unknown;
  };
}

interface GoogleErrorDetails {
  status?: number;
  networkCode?: string;
  reason?: string;
  oauthError?: string;
  apiMessage?: string;
}

export function describeGoogleError(err: unknown): GoogleErrorDetails {
  if (typeof err !== 'object' || err === null) return {};
  const e = err as GoogleErrorShape;
  const status = e.response?.status ?? e.status;
  const details: GoogleErrorDetails = {};
  if (typeof status === 'number') details.status = status;
  if (typeof e.code === 'string' && !/^\d+$/.test(e.code)) details.networkCode = e.code;

  const data = e.response?.data as
    | { error?: string | { message?: string; status?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] }; error_description?: string }
    | undefined;

  if (data && typeof data === 'object') {
    if (typeof data.error === 'string') {
      details.oauthError = data.error;
      if (data.error_description) details.apiMessage = data.error_description;
    } else if (data.error && typeof data.error === 'object') {
      details.reason = data.error.errors?.[0]?.reason ?? data.error.details?.[0]?.reason ?? data.error.status;
      details.apiMessage = data.error.message;
    }
  }
  if (!details.apiMessage && typeof e.message === 'string') details.apiMessage = e.message;
  if (!details.oauthError && typeof e.message === 'string' && /invalid_grant/.test(e.message)) {
    details.oauthError = 'invalid_grant';
  }
  return details;
}

function shorten(text: string | undefined): string {
  if (!text) return '';
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
}

/** Maps a googleapis / google-auth-library error to a stable, actionable ToolError. */
export function mapGoogleError(err: unknown, op: GoogleOperation): ToolError {
  if (err instanceof ToolError) return err;

  const d = describeGoogleError(err);
  const isWrite = op === 'gmail.send' || op === 'docs.batchUpdate';
  const isDocs = op === 'docs.get' || op === 'docs.batchUpdate';
  const detail = shorten(d.apiMessage);
  const withDetail = (msg: string) => (detail ? `${msg} (Google: ${detail})` : msg);

  if (d.oauthError === 'invalid_grant') {
    return new ToolError('AUTH_EXPIRED', `Google authorization has expired or was revoked. ${REAUTH_HINT}`, { cause: err });
  }
  if (d.oauthError === 'admin_policy_enforced' || d.reason === 'admin_policy_enforced' || d.oauthError === 'org_internal') {
    return new ToolError(
      'AUTH_POLICY_BLOCKED',
      'Your Google Workspace administrator does not allow this app to access your account. Contact your admin; this restriction cannot be bypassed.',
      { cause: err },
    );
  }
  if (d.oauthError) {
    return new ToolError('AUTH_EXPIRED', withDetail(`Google rejected the stored authorization (${d.oauthError}). ${REAUTH_HINT}`), { cause: err });
  }

  if (d.status === undefined) {
    if (isWrite && !(d.networkCode && PRE_CONNECT_CODES.has(d.networkCode))) {
      return isDocs
        ? new ToolError(
            'DOCS_APPEND_UNCONFIRMED',
            'The append request did not complete and its result is unknown. Open the document to check whether the text was added before trying again. The server did not retry, to avoid duplicate content.',
            { ambiguous: true, cause: err },
          )
        : new ToolError(
            'GMAIL_SEND_UNCONFIRMED',
            'The send request did not complete and its result is unknown. The email may or may not have been sent; check your Gmail Sent folder before trying again. The server did not retry, to avoid duplicate emails.',
            { ambiguous: true, cause: err },
          );
    }
    return new ToolError(
      'NETWORK_ERROR',
      `Could not reach Google${d.networkCode ? ` (${d.networkCode})` : ''}. Check your internet connection and try again.`,
      { cause: err },
    );
  }

  const status = d.status;
  const reason = d.reason ?? '';

  if (status === 401) {
    return new ToolError('AUTH_EXPIRED', `Google rejected the access token. ${REAUTH_HINT}`, { cause: err });
  }
  if (status === 429 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || reason === 'RATE_LIMIT_EXCEEDED') {
    return new ToolError('RATE_LIMITED', 'Google rate limit reached. Wait a minute and ask again. The server does not automatically retry write operations.', {
      cause: err,
    });
  }
  if (status === 403) {
    if (reason === 'accessNotConfigured' || reason === 'SERVICE_DISABLED') {
      const api = isDocs ? 'Google Docs API' : 'Gmail API';
      return new ToolError('GOOGLE_API_DISABLED', withDetail(`The ${api} is not enabled for your Google Cloud project. Enable it in the Cloud Console and try again.`), {
        cause: err,
      });
    }
    if (reason === 'insufficientPermissions' || reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') {
      return new ToolError('AUTH_SCOPE_MISSING', `The stored authorization is missing a required permission. ${REAUTH_HINT} Grant both Gmail send and Google Docs access.`, {
        cause: err,
      });
    }
    return isDocs
      ? new ToolError('DOC_PERMISSION_DENIED', 'The authenticated Google account does not have edit access to this document. Ask the owner for edit access or use a different document.', {
          cause: err,
        })
      : new ToolError('GMAIL_PERMISSION_DENIED', 'The authenticated Google account is not allowed to send this message. Reconnect or check account permissions.', {
          cause: err,
        });
  }
  if (status === 404 && isDocs) {
    return new ToolError('DOC_NOT_FOUND', 'Document not found. Check the document ID/URL and that the authenticated account can access it.', { cause: err });
  }
  if (status === 400 && op === 'gmail.send') {
    return new ToolError('GMAIL_INVALID_REQUEST', withDetail('Gmail rejected the message. Check the recipient address and content.'), { cause: err });
  }
  if (status >= 500 && isWrite) {
    return isDocs
      ? new ToolError(
          'DOCS_APPEND_UNCONFIRMED',
          `Google returned a server error (${status}) and the append result is unknown. Check the document before trying again; the server did not retry.`,
          { ambiguous: true, cause: err },
        )
      : new ToolError(
          'GMAIL_SEND_UNCONFIRMED',
          `Google returned a server error (${status}) and the send result is unknown. Check your Gmail Sent folder before trying again; the server did not retry.`,
          { ambiguous: true, cause: err },
        );
  }
  return new ToolError('GOOGLE_API_ERROR', withDetail(`Google API request failed with HTTP ${status}.`), { cause: err });
}
