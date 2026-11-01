/**
 * Vercel entry: default-export the Streamable HTTP MCP app.
 *
 * The Hono preset only accepts `app` / `index` / `server` (or the same names
 * under `src/`) and only when that file itself imports the `hono` package.
 * `src/create-app.ts` is not one of those names, so the import has to live here.
 * https://vercel.com/docs/frameworks/backend/hono
 *
 * Local stdio remains `src/index.ts`; long-lived Node HTTP remains `src/http.ts`.
 */
import { Hono } from 'hono';
import { createApp } from './create-app.js';

const app: Hono = createApp();

export default app;
