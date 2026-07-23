package harbor

import (
	"context"

	"github.com/uptrace/bun"
)

// HealthRepository is a liveness probe for Harbor's own database, so the health
// handler doesn't touch the pool directly.
type HealthRepository interface {
	Ping(ctx context.Context) error
}

type healthRepository struct{ db *bun.DB }

func NewHealthRepository(db *bun.DB) HealthRepository { return &healthRepository{db: db} }

func (r *healthRepository) Ping(ctx context.Context) error {
	return r.db.PingContext(ctx)
}
