# google-workspace-mcp

A minimal, local [Model Context Protocol](https://modelcontextprotocol.io) server that lets Cursor, Google Antigravity, Claude Code, and Claude Desktop take two actions in **your** Google account:

| Tool | What it does |
| --- | --- |
| `send_email` | Sends one plain-text email from your Gmail account. |
| `append_to_google_doc` | Appends plain text to the end of an existing Google Doc (first tab) without touching existing content. |

It runs on your machine over `stdio` (or over Streamable HTTP when deployed), uses Google OAuth 2.0 for a single user, and is built with Node.js + TypeScript, the [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/), Zod, and the official `googleapis` client.

> **Both tools perform real writes.** Your MCP host should show you the recipient/subject/body or the target document/text and ask for approval before each call. Do not enable "auto-approve"/"always allow" for these tools.

See [`docs/problemStatement.md`](docs/problemStatement.md) for requirements and [`docs/architecture.md`](docs/architecture.md) for the design.

---

## Requirements

- **Node.js 20.12 or newer** (the MCP SDK requires Node 20+). A `.nvmrc` is included: `nvm use`.
- A Google account, and permission to create a Google Cloud project and OAuth client. If your Google Workspace organization blocks third-party OAuth apps, stop here and talk to your admin; do not try to work around it.

## 1. Google Cloud setup (one time)

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create or select a project.
2. Enable the APIs (**APIs & Services → Library**):
   - **Gmail API**
   - **Google Docs API**
3. Configure **Google Auth Platform** (**APIs & Services → OAuth consent screen**):
   - **Branding:** app name (e.g. `google-workspace-mcp`), support email.
   - **Audience:** *External* for personal Gmail (or *Internal* for your Workspace org). If External and in **Testing** mode, add your Google account under **Test users**.
   - **Data access / scopes:** add
     - `https://www.googleapis.com/auth/gmail.send`
     - `https://www.googleapis.com/auth/documents`
4. **Clients → Create client → Application type: Desktop app.** Where the console offers it, identify the app as an AI-powered agent.
5. Download the client JSON and save it outside version control, e.g.:

   ```bash
   mkdir -p secrets && mv ~/Downloads/client_secret_*.json secrets/credentials.json
   ```

   `secrets/`, `.env`, and token files are already in `.gitignore`.

> Note: the `documents` scope allows editing every Google Doc your account can edit. A narrower `drive.file`-based flow is a possible future improvement.

## 2. Install, authorize, build

```bash
npm install

# Optional: only if your files are not at the defaults
cp .env.example .env   # then edit the two paths

npm run auth           # opens a browser; sign in and approve both permissions
npm run build
```

`npm run auth`:

- Starts a temporary listener on `127.0.0.1` and opens Google's consent page (PKCE + state protected).
- Stores a refresh token at `~/.config/google-workspace-mcp/token.json` (or `GOOGLE_OAUTH_TOKEN_PATH`) with `0600` permissions.
- Fails clearly if consent is denied, a permission box is unchecked, or your admin blocks the app.

Re-run it any time a tool reports `AUTH_REQUIRED`, `AUTH_EXPIRED`, or `AUTH_SCOPE_MISSING`. A running server picks up the new token on the next call; no restart needed.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `GOOGLE_OAUTH_CREDENTIALS_PATH` | `<project>/secrets/credentials.json` | Desktop OAuth client JSON |
| `GOOGLE_OAUTH_TOKEN_PATH` | `~/.config/google-workspace-mcp/token.json` | Refresh token store |
| `GOOGLE_OAUTH_CREDENTIALS_JSON` | (unset) | Inline client JSON (raw or base64); overrides the path when set |
| `GOOGLE_OAUTH_TOKEN_JSON` | (unset) | Seed for the token file on first boot only (raw or base64) |
| `MCP_AUTH_TOKEN` | (required for HTTP) | Bearer token for `POST /mcp` (≥32 chars) |
| `LOG_LEVEL` | `info` | Set to `debug` for more stderr logs |
| `PORT` | `3000` | HTTP listen port (`start:http` / Docker) |

Values come from the environment or `<project>/.env` (environment wins). Relative paths resolve against the project directory, not the host's working directory. Do not put secrets into host configs; use env interpolation where the host supports it.

## 3. Verify with MCP Inspector

```bash
npm run inspect
```

In the Inspector UI, click **Connect → Tools → List Tools**. You should see exactly `send_email` and `append_to_google_doc`.

## 4. Register with your MCP host

All hosts launch the **same** built server; replace `/ABSOLUTE/PATH/google-workspace-mcp` with this directory's absolute path (`pwd`).

> **Use Node 20+ in the host.** Hosts run `node` from their own `PATH`, which may be an older version (e.g. an nvm default of Node 18). If the server fails to start, set `"command"` to an absolute Node 20+ binary, e.g. the output of `nvm which 20` (`/Users/you/.nvm/versions/node/v20.19.6/bin/node`).

Ready-made snippets are in [`examples/`](examples/).

### Cursor

`.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` globally:

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/google-workspace-mcp/dist/index.js"]
    }
  }
}
```

Then open **Cursor Settings → MCP** and check that `google-workspace` is enabled and shows two tools.

### Google Antigravity

Workspace `.agents/mcp_config.json` or global `~/.gemini/config/mcp_config.json`:

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/google-workspace-mcp/dist/index.js"]
    }
  }
}
```

In the Antigravity IDE: **MCP Servers → Manage MCP Servers → View raw config**, then refresh. In Antigravity CLI, run `/mcp`.

### Claude Code

```bash
claude mcp add google-workspace -- node /ABSOLUTE/PATH/google-workspace-mcp/dist/index.js
```

Run `/mcp` in Claude Code to check the connection.

### Claude Desktop

Add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/google-workspace-mcp/dist/index.js"]
    }
  }
}
```

If you keep credentials somewhere other than the defaults and don't use `.env`, add an `env` block with **paths only**:

```json
"env": {
  "GOOGLE_OAUTH_CREDENTIALS_PATH": "/ABSOLUTE/PATH/TO/credentials.json",
  "GOOGLE_OAUTH_TOKEN_PATH": "/ABSOLUTE/USER-PRIVATE/PATH/token.json"
}
```

## 5. Using the tools

> Use `send_email` to email alex@example.com with subject "Project update" and body "The first milestone is complete."

> Use `append_to_google_doc` to append "### Weekly update\nCompleted the first milestone." to https://docs.google.com/document/d/DOCUMENT_ID/edit

Success responses:

```json
{ "success": true, "message": "Email sent successfully", "messageId": "…", "threadId": "…" }
{ "success": true, "message": "Content appended successfully to the end of the document (first tab).", "documentId": "…", "documentUrl": "https://docs.google.com/document/d/…/edit" }
```

Behavior notes:

- The sender is always the authorized account; there is no `from` parameter.
- `to` must be exactly one address. No CC/BCC, HTML, or attachments.
- Appends go to the end of the **first tab**. If the last paragraph has text, the content starts on a new line. Repeating a call appends again; appends are not deduplicated.
- Appended text may take on the style of the paragraph it follows.

### Errors

Failures return `isError: true` with `{ "success": false, "error": "<CODE>", "message": "…" }`.

| Code | Meaning / what to do |
| --- | --- |
| `VALIDATION_ERROR` | Fix the named field. Nothing was sent to Google. |
| `CONFIG_ERROR` | OAuth client file missing or wrong type. See step 1. |
| `AUTH_REQUIRED` / `AUTH_EXPIRED` / `AUTH_SCOPE_MISSING` | Run `npm run auth`. |
| `AUTH_POLICY_BLOCKED` | Your Workspace admin blocks the app. Contact them. |
| `GOOGLE_API_DISABLED` | Enable the Gmail / Docs API in your Cloud project. |
| `GMAIL_PERMISSION_DENIED` / `GMAIL_INVALID_REQUEST` | Gmail refused the message. |
| `DOC_NOT_FOUND` / `DOC_PERMISSION_DENIED` | Wrong document, or your account cannot edit it. |
| `RATE_LIMITED` | Wait and ask again. |
| `NETWORK_ERROR` | Could not reach Google; nothing was written. |
| `GMAIL_SEND_UNCONFIRMED` / `DOCS_APPEND_UNCONFIRMED` | **The result is unknown.** Check your Sent folder or the document before retrying. The server never retries writes automatically. |
| `GOOGLE_API_ERROR` / `INTERNAL_ERROR` | Unexpected; see the stderr logs. |

## Remote deployment (Railway)

The same tools can run as a single-replica HTTPS service. Full steps are in [`docs/deployment-plan.md`](docs/deployment-plan.md). Summary:

1. Keep consent local: `npm run auth` on your machine (Desktop OAuth client). Prefer publishing the consent screen to **In production** so refresh tokens do not expire after 7 days.
2. Build artifacts: `Dockerfile`, `.dockerignore`, and `railway.json` are in the repo. The image runs `node dist/http.js` on `$PORT`.
3. Railway setup: mount a volume at `/data`, set variables, generate a public domain, deploy with one replica.

| Variable | Notes |
| --- | --- |
| `MCP_AUTH_TOKEN` | `openssl rand -base64 48` — required; process exits if missing/short |
| `GOOGLE_OAUTH_CREDENTIALS_JSON` | `base64 < credentials.json` (or raw JSON) |
| `GOOGLE_OAUTH_TOKEN_JSON` | `base64 < ~/.config/google-workspace-mcp/token.json` — **first boot seed only** |
| `GOOGLE_OAUTH_TOKEN_PATH` | `/data/token.json` |
| `LOG_LEVEL` | optional (`info`) |

After the first successful start, **delete `GOOGLE_OAUTH_TOKEN_JSON`** from Railway variables; the volume file is the source of truth (including any rotated refresh token).

Local HTTP check before deploying:

```bash
nvm use
npm run build
MCP_AUTH_TOKEN="$(openssl rand -base64 48)" PORT=3000 npm run start:http
# curl -i http://localhost:3000/healthz   → 200
# curl -i -X POST http://localhost:3000/mcp  → 401
```

Connect hosts to `https://<your-domain>.up.railway.app/mcp` with `Authorization: Bearer <MCP_AUTH_TOKEN>`. Keep host approval prompts on.

**Cursor** (`~/.cursor/mcp.json`) — use env interpolation so the token is not stored in the file:

```json
{
  "mcpServers": {
    "google-workspace": {
      "url": "https://<your-domain>.up.railway.app/mcp",
      "headers": { "Authorization": "Bearer ${env:GOOGLE_WORKSPACE_MCP_TOKEN}" }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add --transport http google-workspace https://<your-domain>.up.railway.app/mcp \
  --header "Authorization: Bearer $GOOGLE_WORKSPACE_MCP_TOKEN"
```

Local stdio and the remote HTTP deployment can both target the same Google account. To re-authorize the deployed server after `AUTH_EXPIRED`, run `npm run auth` locally, then re-seed the volume (see the deployment plan §7.2).

## Development

```bash
npm test          # unit tests with mocked Google APIs + stdio/http protocol tests
npm run typecheck
npm run lint
npm run build
npm start         # node dist/index.js (stdio)
npm run start:http  # node dist/http.js (Streamable HTTP on $PORT)
```

The stdio server logs to **stderr only**; stdout carries MCP JSON-RPC. The HTTP entry also logs to stderr. Logs never contain tokens, email bodies, or document text. Recipients are masked.

### Project layout

```text
src/
  index.ts        entry point: config → auth → stdio server
  http.ts         entry point: bearer auth → Streamable HTTP on /mcp
  server.ts       McpServer + tool registration
  auth.ts         token load/save/refresh/seed (AuthManager)
  gmail.ts        send_email
  docs.ts         append_to_google_doc
  validation.ts   Zod schemas, Doc ID extraction
  errors.ts       error codes + Google error mapping
  result.ts       MCP result helpers
  config.ts       env/.env + path/JSON resolution
  logger.ts       stderr logger with redaction
scripts/authorize.ts   npm run auth
tests/                 vitest suites
examples/              host config snippets
Dockerfile / railway.json   Railway deploy
```

## Manual end-to-end checklist

Use a test account and test document.

1. `npm run auth` with a test Google account.
2. `npm run inspect`: both tools listed.
3. Send a test email to an address you own; confirm it arrives **once**.
4. Create a Google Doc containing `Original content`.
5. Append `Appended content`; `Original content` remains and the new text is on a new last line.
6. Append the same text again; a second copy appears.
7. Try a document you cannot edit; expect `DOC_PERMISSION_DENIED` (or `DOC_NOT_FOUND`).
8. Connect Cursor, Antigravity, or Claude and invoke both tools, approving each call.

## Security

- OAuth client JSON, `.env`, and tokens are git-ignored; the token file is `0600` in a `0700` directory.
- Minimal scopes: `gmail.send` (cannot read mail) and `documents`.
- Header-injection-safe MIME built with nodemailer's `MailComposer`; CR/LF in `to`/`subject` is rejected up front.
- Writes are attempted exactly once; uncertain results are reported, never retried.
- To revoke access: [myaccount.google.com/permissions](https://myaccount.google.com/permissions), then delete the token file.
