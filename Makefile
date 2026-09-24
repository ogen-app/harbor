.PHONY: all build ui ui-install ui-dev run dev-api test tidy proto docker clean

# The repo pins Go 1.26.1 (see go.mod); select it explicitly so a different
# default `go` on PATH still builds with the right toolchain.
export GOTOOLCHAIN := go1.26.1

UI_DIR   := ui
DIST_DIR := src/ui/dist

# ── Single binary ─────────────────────────────────────────────────────────────
# `make all` produces a self-contained server with the UI embedded.
all: ui build

# build compiles the server, embedding whatever currently lives in $(DIST_DIR)
# (a placeholder until `make ui` has run).
build:
	go build -o server ./cmd/server

# ── UI ────────────────────────────────────────────────────────────────────────
# Build the Next.js static export and stage it as the Go embed source.
ui: ui-install
	cd $(UI_DIR) && NEXT_OUTPUT=export npm run build
	rm -rf $(DIST_DIR)
	cp -r $(UI_DIR)/out $(DIST_DIR)

ui-install:
	@[ -d $(UI_DIR)/node_modules ] || (cd $(UI_DIR) && npm install)

# ── Dev ───────────────────────────────────────────────────────────────────────
# Two processes: `make dev-api` (Go, live-reloaded) and `make ui-dev` (Next dev
# server). Next proxies /api to the Go server, so the browser sees one origin.
run: dev-api

# Load .env (if present) so the live-reloaded server sees GOOGLE_CLIENT_ID and
# the other keys; air's child process inherits these exported vars. `set -a`
# auto-exports everything sourced. Dev only — prod/docker-compose set env
# explicitly and never rely on this, and a missing .env is a no-op.
dev-api:
	set -a; [ -f .env ] && . ./.env; set +a; \
	go run github.com/air-verse/air@latest

ui-dev: ui-install
	cd $(UI_DIR) && npm run dev

# ── Checks ────────────────────────────────────────────────────────────────────
test:
	go test ./cmd/... ./src/...

tidy:
	go mod tidy

# ── Protobuf / gRPC ───────────────────────────────────────────────────────────
# tenants.v1 + secrets.v1 + platforms.v1 + plans.v1 + email.v1 + announcements.v1
# live in the shared buf.build/ogen-app/proto module (CON-220). Generate the
# client stubs from a pinned version; bump PROTO_VERSION to adopt a new contract,
# then `make proto` and commit gen/. plans.v1 (PlanAdminService, CON-294) landed
# in v1.4.0; v1.5.0 added tier-version retire/delete + assignment listing
# (CON-297); email.v1 (EmailAdminService, CON-298 — the per-tenant Emails tab,
# CON-192) landed in v1.7.0; announcements.v1 (AnnouncementAdminService, CON-230 —
# the tenant announcements screens, CON-300) lands in v1.8.0; modelconfig.v1
# (ModelConfigAdminService, CON-308 — the Model assignment screens, CON-309)
# lands in v1.10.0.
PROTO_MODULE  := buf.build/ogen-app/proto
PROTO_VERSION := v1.10.0

proto:
	buf generate $(PROTO_MODULE):$(PROTO_VERSION) \
		--path tenants/v1/tenants.proto --path secrets/v1/secrets.proto \
		--path platforms/v1/platforms.proto --path plans/v1/plans.proto \
		--path email/v1/email.proto --path announcements/v1/announcements.proto \
		--path modelconfig/v1/modelconfig.proto

# ── Docker ────────────────────────────────────────────────────────────────────
docker:
	docker build -t harbor .

# ── Cleanup ───────────────────────────────────────────────────────────────────
clean:
	rm -f server
	rm -rf tmp $(UI_DIR)/out $(UI_DIR)/.next
