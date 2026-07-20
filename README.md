# Harbor

Operating center for the [Ogen](../ogen) application.

Harbor is a single Go binary: a [Fiber](https://gofiber.io) API that also serves
an embedded [Next.js](https://nextjs.org) UI (in `ui/`). The backend follows the
conventions established in `../ogen`; the UI is seeded from `../theme-ripoff`.

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
src/handlers/        Fiber handlers (struct + New… + Register(app))
src/server/          Fiber wiring, middleware, embedded-UI static serving
src/ui/              go:embed of the compiled Next.js export (dist/)
ui/                  the Next.js app (App Router, Tailwind, shadcn)
```

## Prerequisites

- Go (the module pins **1.26.1** via `GOTOOLCHAIN`; the Makefile sets it).
- Node 22+ / npm.
- Postgres (via `docker compose up postgres`, or your own).

## Develop

Bring up Postgres, then run the API and UI in two terminals:

```bash
docker compose up -d postgres     # or point DATABASE_DSN at your own

make dev-api                      # terminal 1: Go API on :9002 (live reload via air)
make ui-dev                       # terminal 2: Next dev server (proxies /api → :9002)
```

Open the Next dev server URL it prints. The API alone is at
`http://localhost:9002/api/health`.

Configuration is via environment (see `.env.example` and `src/config/config.go`).

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
and tests.

## Notes

- The UI is copied verbatim from `../theme-ripoff` (still branded "DA'AT Atlas");
  rebrand to Harbor as a follow-up.
- Two edits were made to the seed UI for static-export compatibility: the
  `(main)` layout no longer reads a server cookie, and the sidebar restores its
  collapsed state from `localStorage` on the client instead.
