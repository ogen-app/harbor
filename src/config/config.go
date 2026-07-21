// Package config loads Harbor's runtime configuration from the environment.
// Mirrors the ../ogen config convention: a single flat Config struct with
// envconfig tags + defaults, loaded once at boot via Load.
package config

import "github.com/kelseyhightower/envconfig"

type Config struct {
	// Addr is the listen address for the combined API + embedded UI server.
	// Ogen owns :9001; Harbor takes :9002 so both can run locally at once.
	Addr  string `envconfig:"ADDR"         default:":9002"`
	DSN   string `envconfig:"DATABASE_DSN" default:"postgres://harbor:harbor@localhost:5432/harbor?sslmode=disable"`
	Debug bool   `envconfig:"DEBUG"        default:"false"`

	// Structured logging (mirrors ogen CON-107). LogLevel is the minimum
	// emitted level (debug|info|warn|error; unknown/empty ⇒ info). LogFormat
	// selects the slog handler (json|text); empty resolves per-environment —
	// text when DEBUG=true (local ergonomics), JSON otherwise. See src/logging.
	LogLevel  string `envconfig:"LOG_LEVEL"  default:"info"`
	LogFormat string `envconfig:"LOG_FORMAT" default:""`

	// Connection-pool sizing for the shared bun/pgx pool.
	DBMaxOpenConns int `envconfig:"DB_MAX_OPEN_CONNS" default:"25"`
	DBMaxIdleConns int `envconfig:"DB_MAX_IDLE_CONNS" default:"5"`

	// ── External databases (owned by ../ogen; Harbor connects but NEVER
	// migrates them) ─────────────────────────────────────────────────────────
	// OgenDSN is Ogen's control-plane Postgres — Harbor reads/writes it to
	// operate on Ogen's data. AnalyticsDSN is Ogen's isolated analytics
	// database (TimescaleDB). Both defaults are the exact DSNs from ../ogen and
	// use its docker-compose service hostnames; running on the host, override to
	// localhost:5432 (ogen) and localhost:5433 (timescale). Empty disables the
	// connection.
	OgenDSN      string `envconfig:"OGEN_DATABASE_DSN" default:"postgres://ogen:ogen@postgres:5432/ogen?sslmode=disable"`
	AnalyticsDSN string `envconfig:"ANALYTICS_DSN"     default:"postgres://ogen:ogen@timescaledb:5432/ogen_analytics?sslmode=disable"`

	// CORS allowlist for a decoupled UI origin. Empty (the default) disables
	// the CORS middleware entirely — the production build serves the UI from
	// the same origin as the API (single binary, embedded export), and
	// `next dev` proxies /api to this server, so both are same-origin from the
	// browser's view and no CORS is needed. Set this only if the UI is ever
	// hosted on a separate origin. Must never be "*" while credentials are sent.
	CORSAllowedOrigins string `envconfig:"CORS_ALLOWED_ORIGINS" default:""`

	// ── Google OAuth login ──────────────────────────────────────────────────
	// GoogleClientID / GoogleClientSecret come from the "Web application" OAuth
	// client in Google Cloud Console. The client id is also surfaced to the UI
	// (public) via GET /api/auth/config; the secret stays server-side and is
	// used to exchange the popup authorization code for tokens. When either is
	// empty, Google login is disabled and POST /api/auth/google returns 503.
	GoogleClientID     string `envconfig:"GOOGLE_CLIENT_ID"     default:""`
	GoogleClientSecret string `envconfig:"GOOGLE_CLIENT_SECRET" default:""`

	// AuthAllowedEmails is the login allowlist: only these Google accounts may
	// sign in (matched case-insensitively). Comma-separated; overridable via
	// env. The default seeds the first operator.
	AuthAllowedEmails string `envconfig:"AUTH_ALLOWED_EMAILS" default:""`

	// SessionCookieName is the name of the HttpOnly session cookie.
	SessionCookieName string `envconfig:"SESSION_COOKIE_NAME" default:"harbor_session"`
}

// Load reads the configuration from the process environment.
func Load() (*Config, error) {
	var cfg Config
	if err := envconfig.Process("", &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}
