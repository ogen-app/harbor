// Package harbor holds the bun-backed data-access layer for Harbor's OWN
// Postgres database (users, sessions). Interfaces + a private struct
// implementation per aggregate, mirroring ../ogen. Repositories are split by
// origin database: this package (harbor), plus sibling ogen and analytics
// packages for the external Ogen control-plane and analytics/Timescale pools.
package harbor

import (
	"context"

	"github.com/uptrace/bun"

	"github.com/ogen-app/harbor/src/models"
)

type UserRepository interface {
	GetByID(ctx context.Context, id string) (*models.User, error)
	GetByEmail(ctx context.Context, email string) (*models.User, error)
	// Upsert inserts the user, or on a google_sub conflict refreshes the
	// profile fields. The stored row (including its canonical id) is scanned
	// back into user.
	Upsert(ctx context.Context, user *models.User) error
}

type userRepository struct{ db *bun.DB }

func NewUserRepository(db *bun.DB) UserRepository { return &userRepository{db: db} }

func (r *userRepository) GetByID(ctx context.Context, id string) (*models.User, error) {
	user := new(models.User)
	if err := r.db.NewSelect().Model(user).Where("u.id = ?", id).Scan(ctx); err != nil {
		return nil, err
	}
	return user, nil
}

func (r *userRepository) GetByEmail(ctx context.Context, email string) (*models.User, error) {
	user := new(models.User)
	if err := r.db.NewSelect().Model(user).Where("u.email = ?", email).Scan(ctx); err != nil {
		return nil, err
	}
	return user, nil
}

func (r *userRepository) Upsert(ctx context.Context, user *models.User) error {
	_, err := r.db.NewInsert().
		Model(user).
		On("CONFLICT (google_sub) DO UPDATE").
		Set("email = EXCLUDED.email").
		Set("name = EXCLUDED.name").
		Set("picture = EXCLUDED.picture").
		Set("updated_at = now()").
		Returning("*").
		Exec(ctx)
	return err
}
