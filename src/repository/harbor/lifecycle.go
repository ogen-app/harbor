package harbor

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/uptrace/bun"
)

// StageSnapshot is one tenant's lifecycle stage on one UTC day (CON-437).
type StageSnapshot struct {
	bun.BaseModel `bun:"table:tenant_stage_snapshots,alias:s"`

	SnapshotDate   time.Time       `bun:"snapshot_date,pk,type:date"`
	TenantID       string          `bun:"tenant_id,pk"`
	Progress       string          `bun:"progress"`
	Health         string          `bun:"health"`
	EnteredStageAt time.Time       `bun:"entered_stage_at"`
	Stuck          bool            `bun:"stuck"`
	Reasons        json.RawMessage `bun:"reasons,type:jsonb"`
}

// LifecycleRepository stores the daily lifecycle snapshots in Harbor's own
// database.
type LifecycleRepository struct{ db *bun.DB }

func NewLifecycleRepository(db *bun.DB) *LifecycleRepository { return &LifecycleRepository{db: db} }

// UpsertDay writes the day's rows, replacing any written earlier that day, so
// the job can run more than once a day.
func (r *LifecycleRepository) UpsertDay(ctx context.Context, rows []StageSnapshot) error {
	if len(rows) == 0 {
		return nil
	}
	_, err := r.db.NewInsert().Model(&rows).
		On("CONFLICT (snapshot_date, tenant_id) DO UPDATE").
		Set("progress = EXCLUDED.progress").
		Set("health = EXCLUDED.health").
		Set("entered_stage_at = EXCLUDED.entered_stage_at").
		Set("stuck = EXCLUDED.stuck").
		Set("reasons = EXCLUDED.reasons").
		Set("recorded_at = now()").
		Exec(ctx)
	return err
}

// LatestBefore returns the newest snapshot day before the given UTC date and
// its rows. ok is false when there is none.
func (r *LifecycleRepository) LatestBefore(ctx context.Context, date time.Time) (day time.Time, rows []StageSnapshot, ok bool, err error) {
	var latest sql.NullTime
	err = r.db.NewSelect().Model((*StageSnapshot)(nil)).
		ColumnExpr("max(snapshot_date)").
		Where("snapshot_date < ?", date.Format(time.DateOnly)).
		Scan(ctx, &latest)
	if err != nil || !latest.Valid {
		return time.Time{}, nil, false, err
	}
	err = r.db.NewSelect().Model(&rows).Where("snapshot_date = ?", latest.Time.Format(time.DateOnly)).Scan(ctx)
	if err != nil {
		return time.Time{}, nil, false, err
	}
	return latest.Time, rows, true, nil
}

// History returns one tenant's snapshots, oldest first.
func (r *LifecycleRepository) History(ctx context.Context, tenantID string) ([]StageSnapshot, error) {
	var rows []StageSnapshot
	err := r.db.NewSelect().Model(&rows).Where("tenant_id = ?", tenantID).Order("snapshot_date").Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return rows, err
}

// ChurnedSince maps each tenant whose latest snapshot is churned to the first
// day of that churned run: the first churned snapshot after its last live one.
func (r *LifecycleRepository) ChurnedSince(ctx context.Context) (map[string]time.Time, error) {
	var rows []struct {
		TenantID string    `bun:"tenant_id"`
		Since    time.Time `bun:"since"`
	}
	err := r.db.NewRaw(`
		WITH last_live AS (
			SELECT tenant_id, max(snapshot_date) FILTER (WHERE health <> 'churned') AS live_until
			FROM tenant_stage_snapshots
			GROUP BY tenant_id
		)
		SELECT s.tenant_id, min(s.snapshot_date)::timestamptz AS since
		FROM tenant_stage_snapshots s
		JOIN last_live l ON l.tenant_id = s.tenant_id
		WHERE s.health = 'churned' AND (l.live_until IS NULL OR s.snapshot_date > l.live_until)
		GROUP BY s.tenant_id`).Scan(ctx, &rows)
	if err != nil {
		return nil, err
	}
	out := make(map[string]time.Time, len(rows))
	for _, row := range rows {
		out[row.TenantID] = row.Since
	}
	return out, nil
}
