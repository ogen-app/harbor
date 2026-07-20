// Package logging is Harbor's structured-logging foundation (mirrors ../ogen).
// It builds a configured *slog.Logger (JSON or text, level-controlled),
// installs it as slog's default, and enriches every record with the
// request/user ids carried by the log call's context.
//
// Correlation piggybacks on Fiber's c.Locals(key, value): it stores into the
// fasthttp RequestCtx, which exposes values through (*RequestCtx).Value, so a
// value set via c.Locals(logging.RequestIDKey, id) reads back through
// ctx.Value on the request context. Call sites therefore only need to pass
// c.Context() into slog.*Context.
package logging

import (
	"context"
	"log/slog"
)

// Attribute keys used across the codebase. Centralised so the field names stay
// consistent and greppable.
const (
	AttrComponent = "component"
	AttrRequestID = "request_id"
	AttrUserID    = "user_id"
	AttrError     = "err"
)

// ctxKey types are unexported so the correlation keys cannot collide with — or
// be forged by — other packages. Their exported *Key values double as Fiber
// c.Locals keys (see the package doc).
type requestIDKey struct{}
type userIDKey struct{}

// RequestIDKey and UserIDKey are the context (and Fiber Locals) keys under
// which the request id and user id are stored.
var (
	RequestIDKey = requestIDKey{}
	UserIDKey    = userIDKey{}
)

// WithRequestID returns a copy of ctx carrying the given request id.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, RequestIDKey, id)
}

// WithUserID returns a copy of ctx carrying the given user id.
func WithUserID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, UserIDKey, id)
}

// RequestIDFrom returns the request id carried by ctx and whether a non-empty
// one was present.
func RequestIDFrom(ctx context.Context) (string, bool) {
	v, ok := ctx.Value(RequestIDKey).(string)
	return v, ok && v != ""
}

// UserIDFrom returns the user id carried by ctx and whether a non-empty one was
// present.
func UserIDFrom(ctx context.Context) (string, bool) {
	v, ok := ctx.Value(UserIDKey).(string)
	return v, ok && v != ""
}

// ContextHandler decorates a slog.Handler, enriching every record with the
// request id and user id carried by the log call's context. Values absent from
// the context are omitted — no empty attributes are emitted, so startup logs
// (before any middleware runs) stay clean.
type ContextHandler struct {
	slog.Handler
}

// Handle adds the correlation attributes (when present) and forwards to the
// wrapped handler.
func (h ContextHandler) Handle(ctx context.Context, r slog.Record) error {
	if ctx != nil {
		if id, ok := RequestIDFrom(ctx); ok {
			r.AddAttrs(slog.String(AttrRequestID, id))
		}
		if id, ok := UserIDFrom(ctx); ok {
			r.AddAttrs(slog.String(AttrUserID, id))
		}
	}
	return h.Handler.Handle(ctx, r)
}

// WithAttrs re-wraps so the decorator survives logger.With(...) chains.
func (h ContextHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return ContextHandler{Handler: h.Handler.WithAttrs(attrs)}
}

// WithGroup re-wraps so the decorator survives logger.WithGroup(...) chains.
func (h ContextHandler) WithGroup(name string) slog.Handler {
	return ContextHandler{Handler: h.Handler.WithGroup(name)}
}
