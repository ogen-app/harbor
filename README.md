# Harbor

Operating center ("Ogen' Harbor") for the [Ogen](../ogen) application — an
internal dashboard for observing and operating Ogen's tenants, AI spend, and
databases.

Harbor is a single Go binary: a [Fiber](https://gofiber.io) API that also serves
an embedded [Next.js](https://nextjs.org) UI (in `ui/`). The backend follows the
conventions established in `../ogen`; the UI is seeded from `../theme-ripoff`.
Access is gated by **Google sign-in** against an email allowlist.

## What it does

- **Dashboard** (`/`) — tenant overview, registrations, daily AI token cost,
  daily publishing per platform, and a database teaser.

**Tenants**

- **Tenants** (`/tenants`, `/tenants/{id}`) — a searchable, sortable,
  keyboard-navigable table of Ogen tenants (selectable columns, tier, activity
  sparkline, AI spend). The detail page has tabbed sections (general info,
  recent activity, emails), a per-tenant token-cost chart, and a 90-day
  activity chart; operators can change a tenant's **tier**, lifecycle
  **status**, and **group** membership.
- **Activity** (`/activity`) — global, cross-tenant activity feed.
- **Tiers and groups** (`/tiers-and-groups`) — CRUD for the tier and group
  catalogs.
- **Tier entitlements** (`/tier-entitlements`) — the feature × tier matrix of
  versioned entitlements: draft, publish, retire, and pin tenants to a version.
- **Announcements** (`/announcements`) — author, schedule, and manage tenant
  announcements, with click stats.

**System**

- **Databases** (`/databases`) — live status, size, and per-table stats for the
  connected Postgres databases, auto-refreshing.

**Settings**

- **Platforms** (`/platforms`) — the social-platform catalog: enable/disable,
  reorder, per-platform and global media limits.
- **AI models** (`/ai-models`) — per-flow / per-tier model assignment with
  pricing, plus a "test this slot" action.
- **Email templates** (`/email-templates`) — edit Ogen's transactional email
  templates (`email_templates` table).
- **Secrets** (`/secrets`) — a GitHub-style manager for Ogen's third-party API
  keys (the allowlisted `public.secret` entries). Harbor never touches the
  encrypted table directly; it goes through Ogen's `secrets.Store` over gRPC,
  so envelope encryption, the name allowlist, and hot-reload of rotated keys
  are reused, not duplicated. Values are write-only (set/rotate/clear; never
  read back).

**Resources**

- **Links** (`/links`) — the external service dashboards Harbor integrates with
  (Sentry, etc.).

Keyboard affordances throughout: `g` then a letter jumps between pages
(`g g` home, `g t` tenants, `g a` activity, `g d` databases, `g s` secrets,
`g p` platforms, `g m` AI models, `g e` tier entitlements, `g n`
announcements, `g l` links); `j`/`k`/`↓`/`↑` move a highlighted row in tables
and `o`/`Enter` open it; number keys switch tabs.

## Architecture

```
harbor (one binary)
 ├─ /api/*   → Fiber handlers (src/handlers)
 │              ├─ Postgres (Harbor, Ogen control-plane, Ogen analytics)
 │              └─ gRPC → Ogen internal admin services
 └─ /*       → embedded Next.js static export (src/ui/dist, built from ui/)
```

The UI is compiled to a static export (`output: 'export'`) and embedded into the
binary via `go:embed`, so production is a single self-contained executable —
API and UI on one port (`:9002`). In development the two run as separate
processes and `next dev` proxies `/api/*` to the Go server, so the browser still
sees a single origin.

### Databases

Harbor talks to three Postgres databases:

| Database | Access | Notes |
| --- | --- | --- |
| **Harbor** (`DATABASE_DSN`) | read/write, **migrated** | Its own store (users, sessions). Created on start if missing, then migrated. |
| **Ogen control-plane** (`OGEN_DATABASE_DSN`) | read/write, never migrated | Tenants, users, Zernio profiles, activity. |
| **Ogen analytics / TimescaleDB** (`ANALYTICS_DSN`) | read, never migrated | `vendor_usage_events` → AI token cost. |

The external Ogen databases are **fail-open**: a connect failure at boot is
logged but non-fatal (the pool reconnects on use), so Harbor still serves its
own UI/auth when Ogen is unreachable. An empty DSN disables the connection.

### Ogen gRPC services

Most write paths go through Ogen's internal gRPC admin services rather than
its database, so Ogen's own validation and side effects stay authoritative.
All share one connection configured by `OGEN_GRPC_ADDR` + `OGEN_GRPC_TOKEN`
(the latter must match Ogen's `GRPC_AUTH_TOKEN`); an empty address disables
the features that depend on them (their endpoints report the service as
unavailable, usually with `503`, and the UI shows an empty/unavailable state).

| Service | Harbor client | Used by |
| --- | --- | --- |
| `TenantAdminService` | `src/repository/ogentenants` | tenant tier/status/groups, tiers & groups catalog |
| `SecretsService` | `src/repository/ogensecrets` | Secrets |
| `PlatformAdminService` | `src/repository/ogenplatforms` | Platforms |
| `PlanAdminService` | `src/repository/ogenplans` | Tier entitlements |
| `EmailAdminService` | `src/repository/ogenemail` | tenant Emails tab |
| `AnnouncementAdminService` | `src/repository/ogenannouncements` | Announcements |
| `ModelConfigAdminService` | `src/repository/ogenmodelconfig` | AI models |

The Go stubs in `gen/` are generated by `make proto` from the shared
`buf.build/ogen-app/proto` module, pinned by `PROTO_VERSION` in the Makefile.

## Layout

```
cmd/server/            entrypoint (config → logging → ensure+migrate db → connect external → serve)
src/config/            envconfig Config + Load
src/logging/           slog foundation (JSON/text, request-id correlation)
src/database/          bun Postgres pool, create-on-start (ensure.go), embedded SQL migrations
src/models/            bun-mapped domain types (User, Session)
src/repository/        data-access layer, split by origin:
    harbor/              Harbor's own DB (users, sessions, health)
    ogen/                Ogen control-plane DB (tenants, activity, Zernio, email templates)
    analytics/           Ogen analytics/TimescaleDB (AI spend)
    ogen<service>/       gRPC clients for Ogen admin services (see "Ogen gRPC services")
src/stats/             cross-repository aggregation (tenant overview, db stats)
src/auth/              Google OAuth code exchange + id_token verification
src/handlers/          Fiber handlers + RequireAuth, one file per feature
src/server/            Fiber wiring, middleware, embedded-UI static serving
src/ui/                go:embed of the compiled Next.js export (dist/)
gen/                   generated gRPC client stubs (`make proto`; don't edit)
ui/                    the Next.js app (App Router, Tailwind v4, shadcn, client auth)
```

## API

All data routes require the session cookie (`handlers.RequireAuth`); only the
health check and the auth handshake below are public.

```
# Auth
GET  /api/auth/config              public — { googleClientId } for the UI popup
POST /api/auth/google              public — body { code } → verify + allowlist → session cookie
POST /api/auth/logout              public — revoke session + clear cookie
GET  /api/auth/me                  current user

# Health & status
GET  /api/health                   public — liveness + Harbor DB check
GET  /api/status/databases         status / size / table stats for connected databases

# Tenants (Ogen control-plane + analytics; writes via TenantAdminService)
GET    /api/tenants                        list with metrics + AI spend (filterable via ?filters=)
GET    /api/tenants/overview               aggregated dashboard overview
GET    /api/tenants/registrations          90-day registrations series
GET    /api/tenants/daily-publishes        daily publishes per platform
GET    /api/tenants/:id                    single tenant detail
GET    /api/tenants/:id/activity           recent events + 90-day activity series
GET    /api/tenants/:id/activity/:eventId  single activity event
GET    /api/tenants/:id/users              tenant members
GET    /api/tenants/:id/zernio             connected Zernio (social) accounts
GET    /api/tenants/:id/daily-cost         per-tenant daily token cost by model
GET    /api/tenants/:id/emails             emails sent to the tenant
GET    /api/tenants/:id/emails/:emailId    single email
PUT    /api/tenants/:id/tier               change tier
PUT    /api/tenants/:id/status             change lifecycle status
POST   /api/tenants/:id/groups/:groupId    add to group
DELETE /api/tenants/:id/groups/:groupId    remove from group
GET    /api/activity                       global activity feed

# Tiers & groups catalog
GET|POST        /api/tiers        PUT|DELETE /api/tiers/:id
GET|POST        /api/groups       PUT|DELETE /api/groups/:id

# Tier entitlements
GET    /api/tier-entitlements                            feature × tier matrix
POST   /api/tier-entitlements/tiers/:tierId/versions     new draft version
PUT    /api/tier-entitlements/versions/:id               edit draft
POST   /api/tier-entitlements/versions/:id/publish       publish
POST   /api/tier-entitlements/versions/:id/retire        retire
DELETE /api/tier-entitlements/versions/:id               delete draft
GET    /api/tier-entitlements/versions/:id/assignments   tenants on a version
GET    /api/tier-entitlements/tenants/:tenantId          a tenant's entitlements
PUT    /api/tier-entitlements/tenants/:tenantId/version  pin a tenant to a version

# Announcements
GET|POST        /api/announcements
GET|PUT|DELETE  /api/announcements/:id
PUT             /api/announcements/:id/status

# Platforms
GET|POST        /api/platforms
PUT|DELETE      /api/platforms/:id          (DELETE accepts ?force=true)
PUT             /api/platforms/:id/enabled
GET|PUT         /api/platforms/global-limits

# AI models (model config)
GET    /api/model-config                 bootstrap: flows, slots, tiers, models, pricing
POST   /api/model-config/slot            set a slot's model
POST   /api/model-config/slot/clear      clear a slot override
POST   /api/model-config/slot/global-all set a slot for all tiers
POST   /api/model-config/test            test-run a slot

# Email templates (Ogen control-plane DB)
GET|POST        /api/email-templates
PUT             /api/email-templates/:key

# Secrets (write-only values)
GET    /api/secrets
PUT    /api/secrets/:name
DELETE /api/secrets/:name

# Analytics
GET    /api/analytics/daily-cost         daily token cost by model (all tenants)
```

## Prerequisites

- Go (the module pins **1.26.1** via `GOTOOLCHAIN`; the Makefile sets it).
- Node 22+ / npm.
- Postgres (via `docker compose up postgres`, or your own).
- A Google OAuth 2.0 **Web application** client for login (see
  [Authentication](#authentication)).

## Configuration

Everything is env-driven; copy `.env.example` to `.env` and adjust. Every key +
default lives in `src/config/config.go`.

**Core**

| Key | Purpose |
| --- | --- |
| `ADDR` | Listen address for the combined API + UI (default `:9002`). |
| `DATABASE_DSN` | Harbor's own Postgres — created if missing, then migrated. |
| `OGEN_DATABASE_DSN` | Ogen control-plane Postgres (read/write, never migrated). Empty disables; connect failure is non-fatal. |
| `ANALYTICS_DSN` | Ogen analytics / TimescaleDB (read, never migrated). Empty disables; connect failure is non-fatal. |
| `OGEN_GRPC_ADDR` / `OGEN_GRPC_TOKEN` | Ogen's internal gRPC admin services (e.g. `localhost:9091`); the token must match Ogen's `GRPC_AUTH_TOKEN`. Empty address disables the gRPC-backed features. |
| `DEBUG` / `LOG_LEVEL` / `LOG_FORMAT` | Verbose bun query logging + structured-log level (`debug…error`) and format (`json`/`text`). |
| `DB_MAX_OPEN_CONNS` / `DB_MAX_IDLE_CONNS` | Connection-pool sizing. |
| `CORS_ALLOWED_ORIGINS` | Only if the UI is served from a separate origin (default empty = same-origin; never `*` with credentials). |

**Auth**

| Key | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth client credentials. Empty ⇒ Google login disabled (`503`). |
| `AUTH_ALLOWED_EMAILS` | Comma-separated login allowlist (case-insensitive). **Empty locks everyone out.** |
| `SESSION_COOKIE_NAME` | Session cookie name (default `harbor_session`). |

## Authentication

Sign-in uses Google Identity Services in a popup (OAuth 2.0 authorization-code
flow). The browser sends the one-time code to the backend, which exchanges it
for tokens, verifies the `id_token` against Google, checks the email against
`AUTH_ALLOWED_EMAILS`, upserts the user, and issues an `HttpOnly` session cookie
(see the auth endpoints in the [API](#api) section).

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
has run at least once). `make test` runs the Go suite. `make proto`
regenerates the gRPC stubs in `gen/` (needs [`buf`](https://buf.build)); bump
`PROTO_VERSION` in the Makefile to pick up a new proto release.

## Docker

```bash
docker compose up --build         # Postgres + Harbor
```

The multi-stage `Dockerfile` builds the UI export, embeds it, and produces a
minimal runtime image. On start Harbor creates its own database if it does not
exist yet, then applies migrations — so a fresh Postgres needs no manual setup.

## Adding functionality

Domain entities follow the `../ogen` add-entity flow: a migration under
`src/database/migrations/`, a model, a repository (under the origin-scoped
package in `src/repository/` — `harbor`, `ogen`, or `analytics`), a handler
(`New…Handler(...)` + `Register(app)`), server wiring in `src/server/server.go`,
and tests. Protect authenticated routes with `handlers.RequireAuth`.

Features backed by an Ogen gRPC service instead: add the proto path to the
`proto` target, run `make proto`, add a best-effort client under
`src/repository/ogen<service>/` on the shared gRPC connection, then a handler
that maps "service unavailable" to `503` and wire it in `src/server/server.go`.

## Notes

- The UI is seeded from `../theme-ripoff` and rebranded to "Ogen' Harbor".
- Two edits adapt the seed UI for static export: the `(main)` layout no longer
  reads a server cookie, and the sidebar restores its collapsed state from
  `localStorage` on the client instead.
- Some UI routes (`/audits`, `/documents`, `/design-system`) are leftover
  scaffolding/reference pages from the seed, not linked from the sidebar and
  not wired to live data.
