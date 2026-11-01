/**
 * Vercel entry: default-export the Streamable HTTP MCP app.
 * Recognized as `src/app.ts` — https://vercel.com/docs/frameworks/backend/hono
 *
 * Local stdio remains `src/index.ts`; long-lived Node HTTP remains `src/http.ts`.
 */
import { createApp } from './create-app.js';

export default createApp();
