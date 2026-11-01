# Problem Statement: Build a Minimal Google Workspace MCP Server

**Project name:** `google-workspace-mcp`  
**Target clients:** Cursor, Google Antigravity (IDE/CLI), and Claude (Code/Desktop)  
**Project type:** Beginner-friendly, local MCP server  
**Status:** Implementation brief / requirements, not a completed implementation

## 1. Problem

AI coding assistants can generate the content of an email or a document update, but cannot reliably take those actions in a user's Google account without an authorized integration. Copying text into Gmail or Google Docs manually interrupts the workflow.

Build a **small, reusable Model Context Protocol (MCP) server** that connects a local AI assistant to a user's Google account and exposes exactly two tools:

1. **`send_email`** — send a plain-text email through Gmail.
2. **`append_to_google_doc`** — append plain text to an existing Google Doc without overwriting its current content.

The same server should work in Cursor, Antigravity, and Claude through a standard **local `stdio` MCP connection**. It should be straightforward to build, test, understand, and extend.

## 2. Goal and Expected Outcome

A user should be able to type natural-language requests such as:

> "Use `send_email` to email alex@example.com with subject 'Project update' and body 'The first milestone is complete'."

> "Use `append_to_google_doc` to append '### Weekly update\nCompleted the first milestone.' to this Google Doc: https://docs.google.com/document/d/DOCUMENT_ID/edit"

After an explicit user approval for the action, the MCP server should perform the requested operation using the **authenticated user's Google account**, then return a concise success or failure response.

**Definition of success:** Both tools can be discovered and invoked from at least one MCP client, and the documented setup allows the same server to be registered in Cursor, Antigravity, and Claude without changing the server's business logic.

## 3. Scope

### In scope (MVP)

- Node.js + TypeScript MCP server with `stdio` transport.
- Exactly two public MCP tools: `send_email` and `append_to_google_doc`.
- Google OAuth 2.0 login for a single local user.
- Gmail API integration to send **plain-text** emails.
- Google Docs API integration to **append plain text** to an existing editable document.
- Input validation, readable error messages, and safe local credential handling.
- Clear setup instructions, example MCP client configurations, and basic tests.
- Return Google-generated identifiers / links when successful.

### Out of scope (for the first version)

- Reading or searching Gmail, listing files, or searching Google Drive.
- Creating new Google Docs.
- Attachments, HTML email, CC/BCC, scheduling, mass emailing, or bulk operations.
- Rich-text formatting, inserting tables/images, or editing arbitrary document positions.
- Multi-user accounts, cloud hosting, HTTP transport, database storage, or a web dashboard.
- A third-party MCP service or an unofficial browser-automation approach.

## 4. Users and Use Cases

**Primary user:** A developer using Cursor, Antigravity, or Claude on a personal development machine.

| Use case | User input | Expected outcome |
| --- | --- | --- |
| Send a message | Recipient email, subject, body | One email is sent from the connected Gmail account. |
| Add a meeting note | Existing Google Doc URL/ID, text | New text appears at the end of the specified document while existing content remains intact. |
| Handle an error | Bad email, missing document permissions, expired authorization | No false success message; actionable error returned. |

## 5. Functional Requirements

### FR-1: Gmail sending tool

**MCP tool name:** `send_email`

**Description:** Send one plain-text email from the Google account that the user has explicitly authorized.

**Input schema:**

```json
{
  "to": "alex@example.com",
  "subject": "Project update",
  "body": "Hi Alex, the first milestone is complete."
}
```

| Field | Type | Required | Validation |
| --- | --- | --- | --- |
| `to` | string | Yes | One valid email address; no newlines or header injection. |
| `subject` | string | Yes | Nonempty, reasonable length; no CR/LF header injection. |
| `body` | string | Yes | Nonempty plain text; preserve user-entered line breaks. |

**Behavior:**

1. Validate input.
2. Use the authenticated account, not an arbitrary sender account supplied by the model.
3. Construct a standards-compliant UTF-8 MIME email (prefer a vetted MIME builder rather than manually concatenating untrusted headers).
4. Base64url-encode the MIME message into the Gmail API `raw` field.
5. Call `gmail.users.messages.send({ userId: "me", requestBody: { raw } })`.
6. Return a structured, user-readable outcome.

**Example success response:**

```json
{
  "success": true,
  "message": "Email sent successfully",
  "messageId": "GMAIL_MESSAGE_ID",
  "threadId": "GMAIL_THREAD_ID"
}
```

**Example failure response:**

```json
{
  "success": false,
  "error": "GMAIL_PERMISSION_DENIED",
  "message": "The authenticated Google account is not allowed to send this message. Reconnect or check account permissions."
}
```

**Important:** The operation sends a real email. The client/agent should show the intended recipient, subject, and body and ask the user for explicit confirmation before calling the tool. The MCP server itself must not silently invent recipients or send messages outside a direct user-authorized request.

### FR-2: Google Docs append tool

**MCP tool name:** `append_to_google_doc`

**Description:** Append plain text to the end of the body of an existing Google Doc without deleting or replacing any existing content.

**Input schema:**

```json
{
  "documentId": "DOCUMENT_ID_OR_GOOGLE_DOC_URL",
  "content": "Weekly update\nCompleted the first milestone."
}
```

| Field | Type | Required | Validation |
| --- | --- | --- | --- |
| `documentId` | string | Yes | Accept a Google Docs document ID or a valid `docs.google.com/document/d/...` URL. Extract the ID safely. |
| `content` | string | Yes | Nonempty plain text. Preserve line breaks. |

**Behavior:**

1. Validate the document identifier and content.
2. Use the Google Docs API with the authenticated account.
3. Call `documents.batchUpdate` with an `insertText` request using `endOfSegmentLocation` for the document body; handle paragraph separation so new text does not merge unintentionally with existing text.
4. For documents with multiple tabs, **MVP targets the first tab**. State this in the response/README; optionally add a `tabId` parameter in a later version.
5. Append rather than replace. Keep existing content unchanged.
6. Return the document ID, URL, and success status.

**Illustrative Google Docs request:**

```json
{
  "requests": [
    {
      "insertText": {
        "endOfSegmentLocation": {},
        "text": "\nWeekly update\nCompleted the first milestone."
      }
    }
  ]
}
```

This request is illustrative; handle leading/trailing newline logic and Google Docs tab semantics in the implementation. The Google Docs API `endOfSegmentLocation` inserts immediately before the segment's final newline, so test empty and nonempty documents.

**Example success response:**

```json
{
  "success": true,
  "message": "Content appended successfully",
  "documentId": "DOCUMENT_ID",
  "documentUrl": "https://docs.google.com/document/d/DOCUMENT_ID/edit"
}
```

**Important:** The client/agent should show the target document and exact text to be added, then request user confirmation before modifying the document. A repeat call is another append, not an update or deduplicated write.

### FR-3: Authentication and authorization

- Use **Google OAuth 2.0 with an installed/desktop application client**, not a Google account password or hard-coded API key.
- Support an explicit one-time local browser login through a separate command such as `npm run auth` before starting the MCP server.
- Request the minimal functional scopes for this MVP:
  - `https://www.googleapis.com/auth/gmail.send`
  - `https://www.googleapis.com/auth/documents`
- Note: The Docs scope is relatively broad. For a more constrained future version, investigate per-file access with `drive.file` and an explicit document selection flow.
- Store refreshed tokens securely on the local machine. Never commit client credentials, access tokens, or refresh tokens.
- Refresh expired access tokens automatically when possible.
- If consent is denied, scopes are missing, tokens are revoked, or the user has no edit permission, return an informative error.
- Do not use a service-account impersonation workaround for a basic personal-account MVP.

### FR-4: MCP client interoperability

- The server must speak MCP over stdin/stdout using a **local `stdio` transport**.
- It must advertise both tools and their input schemas to the client.
- It must not write ordinary logs to stdout; diagnostics go to stderr.
- It must use absolute paths in local client configuration examples.
- The executable should start via `node /ABSOLUTE/PATH/google-workspace-mcp/dist/index.js` after a normal build.
- Gmail and Docs credentials are configured **in the server**, not in each client; the same authorization can serve local clients running for the same OS user.

## 6. Proposed Technical Approach

| Component | Choice | Why |
| --- | --- | --- |
| Language | TypeScript on Node.js 20+ | Familiar, typed, beginner-friendly. |
| MCP SDK | Current stable MCP TypeScript **v2** (`@modelcontextprotocol/server`) | Official MCP server API. |
| Transport | `stdio` | Simplest local integration; no hosted endpoint. |
| Schema validation | `zod` | Explicit MCP tool input schemas. |
| Google APIs | `googleapis` | Official Google Workspace API client. |
| OAuth | Google OAuth desktop client; optionally `@google-cloud/local-auth` for initial login | Browser-based authorization for one local user. |
| Email construction | Standards-compliant MIME builder | Correct UTF-8/headers and injection resistance. |
| Tests | Node test runner or Vitest, with mocked Google API clients | Fast tests without sending real messages. |

**Architecture:**

```text
Cursor / Antigravity / Claude
           |
           | MCP (stdio)
           v
  Local TypeScript MCP server
           |
           +--> send_email ----------> Gmail API ------> Email sent
           |
           +--> append_to_google_doc -> Google Docs API -> Text appended
           |
           +--> Google OAuth token/credential store (local only)
```

**Suggested project structure:**

```text
google-workspace-mcp/
├── src/
│   ├── index.ts                 # MCP stdio server and tool registration
│   ├── auth.ts                  # OAuth login, token load/save and refresh
│   ├── gmail.ts                 # send_email implementation
│   ├── docs.ts                  # append_to_google_doc implementation
│   └── validation.ts            # Input validation and document ID extraction
├── scripts/
│   └── authorize.ts             # One-time interactive OAuth setup
├── tests/
│   ├── gmail.test.ts
│   └── docs.test.ts
├── .env.example                 # Non-secret path/config placeholders only
├── .gitignore                   # Exclude .env, credentials and token files
├── package.json
├── tsconfig.json
├── README.md
└── problemStatement.md
```

The implementation must follow the installed MCP SDK **v2** APIs rather than copying old v1 `@modelcontextprotocol/sdk` imports. In v2, use `McpServer`, tool registration, and `serveStdio` from the documented packages.

## 7. Google Cloud Setup Requirements

The README produced by the coding assistant must explain these steps:

1. Create or choose a Google Cloud project.
2. Enable **Gmail API** and **Google Docs API**.
3. Configure **Google Auth Platform** branding, audience, and required scopes; add test users if using an External app in testing mode.
4. Create an **OAuth 2.0 Desktop app** client. Where offered, identify the app as an AI-powered agent.
5. Download the OAuth client JSON and store it outside version control (for example, a local `secrets/credentials.json` path excluded by `.gitignore`).
6. Install npm dependencies.
7. Run the separate authorization command in an interactive local terminal; sign into the account and grant Gmail-send and Docs-edit access.
8. Build and run the server locally.
9. Register its absolute executable path with an MCP host, refresh/restart the host, and confirm both tools are discoverable.

**Example `.env.example` (placeholder values only):**

```dotenv
GOOGLE_OAUTH_CREDENTIALS_PATH=/ABSOLUTE/PATH/TO/credentials.json
GOOGLE_OAUTH_TOKEN_PATH=/ABSOLUTE/USER-PRIVATE/PATH/google-workspace-mcp-token.json
```

Keep the true `.env`, downloaded client credentials, and token store out of source control. Give the token file restrictive OS permissions. If Google Workspace organizational policy disallows OAuth or third-party agent access, stop and report that restriction rather than circumventing it.

## 8. MCP Client Configuration Examples

These all point to the **same built local server**. Replace `/ABSOLUTE/PATH/google-workspace-mcp` with the actual location. If the server needs environment variables, arrange for the process to receive them safely (for example, through an explicitly documented `env` block or secure launcher); do not commit real secrets to the config.

### Cursor

Configure `.cursor/mcp.json` in the project or `~/.cursor/mcp.json` globally:

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

### Google Antigravity

Configure your workspace's `.agents/mcp_config.json` or the global `~/.gemini/config/mcp_config.json`:

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

In the Antigravity IDE, open **MCP Servers → Manage MCP Servers → View raw config**, then refresh the MCP servers. In Antigravity CLI, check `/mcp`.

### Claude Code

Register the server from a terminal:

```bash
claude mcp add google-workspace -- node /ABSOLUTE/PATH/google-workspace-mcp/dist/index.js
```

Run `/mcp` in Claude Code to inspect the connection.

### Claude Desktop

Add a matching entry under the `mcpServers` key in your Claude Desktop `claude_desktop_config.json` file:

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

**Note:** Claude Code and Claude Desktop use different configuration workflows, though both can run the same local server.

## 9. Security and Reliability Requirements

- Both operations are **write actions**. Expose them as intentional, user-initiated tools, and require host-side confirmation of arguments before invocation.
- Never silently send a message or edit a document as a result of instructions embedded in untrusted web pages, emails, or document content.
- Never log Google tokens, authorization codes, full user email bodies, or sensitive document text.
- Validate all arguments; reject missing or empty values, malformed document URLs, invalid addresses, and oversized inputs.
- Sanitize email header fields to prevent CR/LF injection; use a proper MIME encoder.
- Handle Google API errors (401, 403, 404, 429, 5xx), with actionable messages; retry only when safe.
- **Do not automatically retry an ambiguous failed email send**: the server may have sent it already, and repeating can deliver duplicates. Tell the user when success cannot be confirmed.
- Do not automatically retry an ambiguous failed document append, because that can duplicate content.
- For successful responses, return only necessary metadata. For failed responses, never incorrectly report success.
- Preserve existing Google Doc text and formatting. Appending plain text may inherit the surrounding text's style; rich formatting is out of scope.

## 10. Test Plan

**Automated tests (mock Google API calls):**

| Test | Expected result |
| --- | --- |
| Valid `send_email` input | Exactly one correctly encoded Gmail send request. |
| Invalid recipient or injected email headers | Rejected before contacting Gmail. |
| Empty subject/body | Rejected with validation error. |
| Valid Google Doc ID | Exactly one Docs `batchUpdate` insert at end of body. |
| Valid Docs URL | Correct document ID extracted. |
| Invalid Docs URL/ID or empty content | Rejected before API call. |
| Missing/expired/revoked OAuth token | Refreshed safely when possible or human-readable reauthorization error. |
| Gmail/Docs API permission or rate-limit failure | Proper failure returned; no false success. |
| stdout discipline | MCP JSON-RPC output only; ordinary logs use stderr. |

**Manual end-to-end checks (use test data):**

1. Run `npm run auth` and authorize a test Google account.
2. Connect to the server using **MCP Inspector** and verify both tools are listed.
3. Send a **test email to an address you own**; confirm it appears exactly once.
4. Create a test Google Doc containing `Original content`.
5. Append `\nAppended content` and verify `Original content` remains intact and the new text appears at the bottom.
6. Repeat the append intentionally and confirm the second call adds a second copy (document behavior is append-only, not idempotent).
7. Test a document you cannot edit and verify a clear permission error.
8. Connect at least one of Cursor, Antigravity, or Claude and invoke both tools after reviewing the requested actions.

## 11. Acceptance Criteria / Definition of Done

The MVP is complete when:

- [ ] `npm install`, `npm run auth`, `npm run build`, and the documented start command work on a fresh local setup.
- [ ] The running MCP server exposes only `send_email` and `append_to_google_doc`.
- [ ] The account owner authorizes Gmail and Docs access through OAuth; no secrets are committed.
- [ ] One valid email is delivered through Gmail with the requested recipient, subject, and body.
- [ ] New text is appended to an existing Google Doc without deleting its prior content.
- [ ] Invalid inputs and API failures return understandable errors.
- [ ] Sensitive values are not logged; stdout remains reserved for MCP messages.
- [ ] Mocked unit tests and an Inspector-based manual test pass.
- [ ] The README provides working setup, authentication, and MCP configuration steps for Cursor, Antigravity, Claude Code, and Claude Desktop.
- [ ] The app does not send or append without a direct request and client-side user confirmation.

## 12. Implementation Sequence for an AI Coding Assistant

Implement the smallest working version in the following order:

1. Scaffold a TypeScript project with scripts (`auth`, `build`, `start`, `test`) and install the current MCP v2 SDK, Zod, and Google API client.
2. Implement OAuth bootstrap, local token persistence, and automatic access-token refresh.
3. Implement and mock-test `send_email`.
4. Implement and mock-test `append_to_google_doc`.
5. Register both tools with the MCP server and run it over `stdio`.
6. Build and validate tool discovery and responses with MCP Inspector.
7. Write the README and example config files for each supported host.
8. Test the Google integrations end-to-end with a test email and test document.

**Do not add additional tools, cloud infrastructure, or a UI before completing these steps.**

### Copy-paste build prompt for Cursor / Antigravity / Claude

> Read `problemStatement.md` and implement this project end to end. Use Node.js + TypeScript, the current stable MCP TypeScript SDK v2, Zod, and the Google APIs Node.js client. Create an MCP server over local stdio with exactly two tools: `send_email` and `append_to_google_doc`. Implement OAuth for one local user through a separate interactive authorization command, securely persist refreshable credentials, validate inputs, avoid stdout logging, and return structured results. Include unit tests with mocked APIs, a README with Google Cloud prerequisites, and configuration examples for Cursor, Antigravity, Claude Code, and Claude Desktop. Require user approval for write actions. Start with a minimal implementation; do not add unrelated features. If credentials are absent, explain setup rather than fabricating them.

## 13. Official References

- [MCP TypeScript SDK v2 — getting started](https://ts.sdk.modelcontextprotocol.io/v2/)
- [MCP server package (`@modelcontextprotocol/server`)](https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/server/)
- [Gmail API — sending messages](https://developers.google.com/workspace/gmail/api/guides/sending)
- [Gmail API — `users.messages.send`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send)
- [Google Docs API — `documents.batchUpdate`](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate)
- [Google Docs API — `InsertTextRequest` and `EndOfSegmentLocation`](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request)
- [Google Docs API — authorization scopes](https://developers.google.com/workspace/docs/api/auth)
- [Gmail API — Node.js OAuth quickstart](https://developers.google.com/workspace/gmail/api/quickstart/nodejs)
- [Cursor MCP configuration](https://cursor.com/docs/mcp)
- [Antigravity MCP configuration](https://antigravity.google/docs/mcp)
- [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)

---

**Deliverable requested:** A working, local, two-tool Google Workspace MCP server plus a setup and testing guide. This file is the problem statement and specification to hand to a coding agent; it does not itself send email or modify documents.
