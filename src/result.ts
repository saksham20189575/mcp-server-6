import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ToolError } from './errors.js';

export function ok(message: string, data: Record<string, string>): CallToolResult {
  const structured = { success: true, message, ...data };
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

export function fail(err: ToolError): CallToolResult {
  const structured = { success: false, error: err.code, message: err.message };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}
