package harbor

import (
	"context"

	"github.com/uptrace/bun"

	"github.com/ogen-app/harbor/src/models"
)

type SessionRepository interface {
	Create(ctx context.Context, session *models.Session) error
	// GetByID returns the session for the given token, or sql.ErrNoRows if none.
	GetByID(ctx context.Context, id string) (*models.Session, error)
	Delete(ctx context.Context, id string) (bool, error)
}

type sessionRepository struct{ db *bun.DB }

func NewSessionRepository(db *bun.DB) SessionRepository { return &sessionRepository{db: db} }

func (r *sessionRepository) Create(ctx context.Context, session *models.Session) error {
	_, err := r.db.NewInsert().Model(session).Exec(ctx)
	return err
}

func (r *sessionRepository) GetByID(ctx context.Context, id string) (*models.Session, error) {
	session := new(models.Session)
	if err := r.db.NewSelect().Model(session).Where("s.id = ?", id).Scan(ctx); err != nil {
		return nil, err
	}
	return session, nil
}

func (r *sessionRepository) Delete(ctx context.Context, id string) (bool, error) {
	res, err := r.db.NewDelete().Model((*models.Session)(nil)).Where("id = ?", id).Exec(ctx)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}
