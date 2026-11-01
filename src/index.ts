#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { google } from 'googleapis';
import { AuthManager } from './auth.js';
import { loadConfig, loadDotEnv } from './config.js';
import type { DocsApi } from './docs.js';
import type { GmailApi } from './gmail.js';
import { log } from './logger.js';
import { createServer, SERVER_VERSION, type GoogleServices } from './server.js';

loadDotEnv();
const config = loadConfig();
const auth = new AuthManager(config);

const services: GoogleServices = {
  async gmail(): Promise<GmailApi> {
    return google.gmail({ version: 'v1', auth: await auth.getAuthorizedClient() });
  },
  async docs(): Promise<DocsApi> {
    return google.docs({ version: 'v1', auth: await auth.getAuthorizedClient() });
  },
};

process.on('unhandledRejection', (reason) => {
  log.error('process.unhandled_rejection', { error: reason instanceof Error ? reason.message : String(reason) });
});

serveStdio(() => createServer(services), {
  onerror: (err) => log.error('transport.error', { error: err.message }),
});

log.info('server.started', { version: SERVER_VERSION, transport: 'stdio', tokenPath: config.tokenPath });
