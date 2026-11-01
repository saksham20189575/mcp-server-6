type Level = 'debug' | 'info' | 'warn' | 'error';

type Fields = Record<string, string | number | boolean | null | undefined>;

const SECRET_PATTERNS: RegExp[] = [
  /ya29\.[A-Za-z0-9._-]+/g,
  /1\/\/[A-Za-z0-9._-]{20,}/g,
  /4\/[A-Za-z0-9._-]{20,}/g,
  /"?(access_token|refresh_token|id_token|client_secret)"?\s*[:=]\s*"?[^",\s}]+/gi,
];

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((acc, re) => acc.replace(re, '[REDACTED]'), text);
}

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

// All output goes to stderr: stdout is reserved for MCP JSON-RPC messages.
function write(level: Level, event: string, fields: Fields = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  process.stderr.write(`${redact(line)}\n`);
}

export const log = {
  debug: (event: string, fields?: Fields) => {
    if (process.env.LOG_LEVEL === 'debug') write('debug', event, fields);
  },
  info: (event: string, fields?: Fields) => write('info', event, fields),
  warn: (event: string, fields?: Fields) => write('warn', event, fields),
  error: (event: string, fields?: Fields) => write('error', event, fields),
};
