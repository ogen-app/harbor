package ogen

import (
	"context"
	"time"

	"github.com/uptrace/bun"
)

// EmailTemplate is one editable transactional/marketing email template from the
// Ogen control-plane `email_templates` table (CON-154). Keyed by a stable
// string key ("welcome", "password_reset", …); the body carries [[ .Var ]]
// placeholders rendered at send time. Read-only here — Harbor surfaces these for
// operators to review and (later) edit.
type EmailTemplate struct {
	Key       string    `bun:"key"        json:"key"`
	Subject   string    `bun:"subject"    json:"subject"`
	HTML      string    `bun:"html"       json:"html"`
	Text      string    `bun:"text"       json:"text"`
	Kind      string    `bun:"kind"       json:"kind"`
	Version   int       `bun:"version"    json:"version"`
	UpdatedAt time.Time `bun:"updated_at" json:"updatedAt"`
}

// EmailTemplateRepository reads email templates from the Ogen pool. Like the
// other Ogen repositories every read is best-effort: a nil pool yields
// ErrUnavailable and the caller renders a soft "unavailable" state.
type EmailTemplateRepository interface {
	// Available reports whether the Ogen pool is configured.
	Available() bool
	// List returns every template, ordered by kind then key for a stable UI.
	List(ctx context.Context) ([]EmailTemplate, error)
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
	const q = `SELECT key, subject, html, text, kind, version, updated_at
	           FROM email_templates
	           ORDER BY kind, key`
	if err := r.db.NewRaw(q).Scan(ctx, &rows); err != nil {
		return nil, err
	}
	return rows, nil
}
