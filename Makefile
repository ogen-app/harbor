.PHONY: all build ui ui-install ui-dev run dev-api test tidy docker clean

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

dev-api:
	go run github.com/air-verse/air@latest

ui-dev: ui-install
	cd $(UI_DIR) && npm run dev

# ── Checks ────────────────────────────────────────────────────────────────────
test:
	go test ./cmd/... ./src/...

tidy:
	go mod tidy

# ── Docker ────────────────────────────────────────────────────────────────────
docker:
	docker build -t harbor .

# ── Cleanup ───────────────────────────────────────────────────────────────────
clean:
	rm -f server
	rm -rf tmp $(UI_DIR)/out $(UI_DIR)/.next
