# Harbor

Operating center ("Ogen' Harbor") for the [Ogen](../ogen) application.

Harbor is a single Go binary: a [Fiber](https://gofiber.io) API that also serves
an embedded [Next.js](https://nextjs.org) UI (in `ui/`). The backend follows the
conventions established in `../ogen`; the UI is seeded from `../theme-ripoff`.
Access is gated by **Google sign-in** against an email allowlist.

## Architecture

```
harbor (one binary)
 ├─ /api/*   → Fiber handlers (src/handlers)
 └─ /*       → embedded Next.js static export (src/ui/dist, built from ui/)
```

The UI is compiled to a static export (`output: 'export'`) and embedded into the
binary via `go:embed`, so production is a single self-contained executable —
API and UI on one port (`:9002`). In development the two run as separate
processes and `next dev` proxies `/api/*` to the Go server, so the browser still
sees a single origin.

## Layout

```
cmd/server/          entrypoint (config → logging → db → migrate → serve)
src/config/          envconfig Config + Load
src/logging/         slog foundation (JSON/text, request-id correlation)
src/database/        bun Postgres pool + embedded SQL migrations
src/models/          bun-mapped domain types (User, Session)
src/repository/      data-access layer (User, Session repositories)
src/auth/            Google OAuth code exchange + id_token verification
src/handlers/        Fiber handlers + RequireAuth (struct + New… + Register)
src/server/          Fiber wiring, middleware, embedded-UI static serving
src/ui/              go:embed of the compiled Next.js export (dist/)
ui/                  the Next.js app (App Router, Tailwind, shadcn, client auth)
```

## Prerequisites

- Go (the module pins **1.26.1** via `GOTOOLCHAIN`; the Makefile sets it).
- Node 22+ / npm.
- Postgres (via `docker compose up postgres`, or your own).
- A Google OAuth 2.0 **Web application** client for login (see
  [Authentication](#authentication)).

## Configuration

Everything is env-driven; copy `.env.example` to `.env` and adjust. Every key +
default lives in `src/config/config.go`. Auth-related keys:

| Key | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth client credentials. Empty ⇒ Google login disabled (`503`). |
| `AUTH_ALLOWED_EMAILS` | Comma-separated login allowlist (case-insensitive). **Empty locks everyone out.** |
| `SESSION_COOKIE_NAME` | Session cookie name (default `harbor_session`). |

## Authentication

Sign-in uses Google Identity Services in a popup (OAuth 2.0 authorization-code
flow). The browser sends the one-time code to the backend, which exchanges it
for tokens, verifies the `id_token` against Google, checks the email against
`AUTH_ALLOWED_EMAILS`, upserts the user, and issues an `HttpOnly` session cookie.

Endpoints:

```
GET  /api/auth/config    public — { googleClientId } for the UI popup
POST /api/auth/google    body { code } → verify + allowlist → session cookie
GET  /api/auth/me        current user (requires session)
POST /api/auth/logout    revoke session + clear cookie
```

- The session cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` **only when the
  request is HTTPS** (directly or via `X-Forwarded-Proto`) — so it works over
  `http://localhost` in dev and stays secure behind TLS in prod.
- The UI guards routes client-side (`AuthGuard` redirects anonymous visitors to
  `/login`); the *real* protection is that data APIs require the cookie. Wrap new
  data routes in `handlers.RequireAuth`.

### Google Cloud Console setup

1. **OAuth consent screen** — External; scopes `openid`, `email`, `profile`.
   While in "Testing", add each operator as a **test user**.
2. **Credentials → OAuth client ID → Web application**:
   - Authorized JavaScript origins: `http://localhost:3000` (Next dev),
     `http://localhost:9002` (single binary), and your production origin.
   - No redirect URI is needed (the popup uses `postmessage`).
3. Put the client id/secret and your allowlist in `.env`
   (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AUTH_ALLOWED_EMAILS`).

## Develop

Bring up Postgres, set your `.env` (incl. the Google keys above), then run the
API and UI in two terminals:

```bash
docker compose up -d postgres     # or point DATABASE_DSN at your own

make dev-api                      # terminal 1: Go API on :9002 (live reload via air)
make ui-dev                       # terminal 2: Next dev server (proxies /api → :9002)
```

Open the Next dev server URL it prints and sign in with an allowlisted Google
account. The API alone is at `http://localhost:9002/api/health`.

## Build & run the single binary

```bash
make all      # builds the Next.js export, stages it into src/ui/dist, then `go build`
./server      # serves API + UI on :9002
```

`make ui` (re)builds just the UI export; `make build` compiles the server with
whatever is currently staged in `src/ui/dist` (a placeholder until `make ui`
has run at least once).

## Docker

```bash
docker compose up --build         # Postgres + Harbor
```

The multi-stage `Dockerfile` builds the UI export, embeds it, and produces a
minimal runtime image.

## Adding functionality

Domain entities follow the `../ogen` add-entity flow: a migration under
`src/database/migrations/`, a model, a repository, a handler
(`New…Handler(...)` + `Register(app)`), server wiring in `src/server/server.go`,
and tests. Protect authenticated routes with `handlers.RequireAuth`.

## Notes

- The UI is seeded from `../theme-ripoff` and rebranded to "Ogen' Harbor".
- Two edits adapt the seed UI for static export: the `(main)` layout no longer
  reads a server cookie, and the sidebar restores its collapsed state from
  `localStorage` on the client instead.
