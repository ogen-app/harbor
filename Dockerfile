# syntax=docker/dockerfile:1

# ── UI: build the Next.js static export ───────────────────────────────────────
FROM node:22-alpine AS ui
WORKDIR /app/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
RUN NEXT_OUTPUT=export npm run build

# ── Go: build the server with the export embedded ─────────────────────────────
FROM golang:1.26-alpine AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Replace the committed placeholder with the freshly built export.
RUN rm -rf src/ui/dist
COPY --from=ui /app/ui/out ./src/ui/dist
RUN CGO_ENABLED=0 go build -o /harbor ./cmd/server

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM alpine:3.20
RUN adduser -D -u 10001 harbor
USER harbor
COPY --from=build /harbor /usr/local/bin/harbor
EXPOSE 9002
ENTRYPOINT ["/usr/local/bin/harbor"]
