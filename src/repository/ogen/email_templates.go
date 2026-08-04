package ogen

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/uptrace/bun"
)

// ErrDuplicateKey is returned by Create when a template with the given key
// already exists (the key is the table's primary key).
var ErrDuplicateKey = errors.New("email template already exists")

// EmailTemplate is one editable transactional/marketing email template from the
// Ogen control-plane `email_templates` table (CON-154). Keyed by a stable
// string key ("welcome", "password_reset", …); the body carries [[ .Var ]]
// placeholders rendered at send time. Harbor surfaces these for operators to
// review and edit (subject + HTML body).
type EmailTemplate struct {
	Key     string `bun:"key"     json:"key"`
	Subject string `bun:"subject" json:"subject"`
	HTML    string `bun:"html"    json:"html"`
	Text    string `bun:"text"    json:"text"`
	Kind    string `bun:"kind"    json:"kind"`
	Version int    `bun:"version" json:"version"`
	// Variables documents the template's runtime placeholders: key = the
	// [[ .Key ]] name, value = a human explanation. Code-owned metadata Ogen's
	// seeder keeps in sync (a jsonb column); read-only here.
	Variables map[string]string `bun:"variables"  json:"variables"`
	UpdatedAt time.Time         `bun:"updated_at" json:"updatedAt"`
}

// columns lists the template columns Harbor reads, shared by every statement's
// RETURNING/SELECT so the row shape stays in one place.
const emailTemplateColumns = `key, subject, html, text, kind, version, variables, updated_at`

// EmailTemplateRepository reads and writes email templates on the Ogen pool.
// Reads are best-effort: a nil pool yields ErrUnavailable and the caller renders
// a soft "unavailable" state. Writes edit the rows Ogen seeds on boot (its
// seeder is upsert-if-absent, so operator edits persist across redeploys).
type EmailTemplateRepository interface {
	// Available reports whether the Ogen pool is configured.
	Available() bool
	// List returns every template, ordered by kind then key for a stable UI.
	List(ctx context.Context) ([]EmailTemplate, error)
	// Create inserts a new template with the given key, subject and kind —
	// empty bodies, version 1 — and returns the stored row. Returns
	// ErrDuplicateKey if the key is already taken. kind must be a value the
	// table's CHECK allows ("transactional" or "marketing").
	Create(ctx context.Context, key, subject, kind string) (*EmailTemplate, error)
	// Update saves a template's subject and HTML body and refreshes updated_at,
	// leaving kind/version/text untouched. Returns the stored row, or
	// sql.ErrNoRows if the key is unknown.
	Update(ctx context.Context, key, subject, html string) (*EmailTemplate, error)
}

type emailTemplateRepository struct{ db *bun.DB }

func NewEmailTemplateRepository(db *bun.DB) EmailTemplateRepository {
	return &emailTemplateRepository{db: db}
}

func (r *emailTemplateRepository) Available() bool { return r.db != nil }

func (r *emailTemplateRepository) List(ctx context.Context) ([]EmailTemplate, error) {
	if r.db == nil {
		return nil, ErrUnavailable
	}
	var rows []EmailTemplate
	if err := r.db.NewRaw(
		`SELECT `+emailTemplateColumns+` FROM email_templates ORDER BY kind, key`,
	).Scan(ctx, &rows); err != nil {
		return nil, err
	}
	return rows, nil
}

func (r *emailTemplateRepository) Create(ctx context.Context, key, subject, kind string) (*EmailTemplate, error) {
	if r.db == nil {
		return nil, ErrUnavailable
	}
	// ON CONFLICT DO NOTHING makes a taken key return no row; Scan then reports
	// sql.ErrNoRows, which we translate to ErrDuplicateKey.
	var row EmailTemplate
	err := r.db.NewRaw(
		`INSERT INTO email_templates (key, subject, html, text, kind)
		 VALUES (?, ?, '', '', ?)
		 ON CONFLICT (key) DO NOTHING
		 RETURNING `+emailTemplateColumns,
		key, subject, kind,
	).Scan(ctx, &row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrDuplicateKey
		}
		return nil, err
	}
	return &row, nil
}

func (r *emailTemplateRepository) Update(ctx context.Context, key, subject, html string) (*EmailTemplate, error) {
	if r.db == nil {
		return nil, ErrUnavailable
	}
	var row EmailTemplate
	err := r.db.NewRaw(
		`UPDATE email_templates
		 SET subject = ?, html = ?, updated_at = now()
		 WHERE key = ?
		 RETURNING `+emailTemplateColumns,
		subject, html, key,
	).Scan(ctx, &row)
	if err != nil {
		return nil, err // sql.ErrNoRows when the key is unknown
	}
	return &row, nil
}
