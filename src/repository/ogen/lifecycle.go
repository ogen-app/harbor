package ogen

import (
	"context"
	"fmt"
	"time"

	"github.com/uptrace/bun"
)

// LifecycleSignal is one tenant's raw lifecycle input for the Lifecycle tab
// : the milestone timestamps, its last activity and the problems that
// explain why it may be stuck. Harbor's stats/lifecycle turns it into a stage.
type LifecycleSignal struct {
	ID        string     `bun:"id"`
	Name      string     `bun:"name"`
	Status    string     `bun:"status"`
	CreatedAt time.Time  `bun:"created_at"`
	DeletedAt *time.Time `bun:"deleted_at"`
	// FirstSocialAt is the first social account connection, deleted accounts
	// included: the milestone was reached even if the account is gone.
	FirstSocialAt *time.Time `bun:"first_social_at"`
	// FirstPostAt is the first published post; RegularAt the first post of the
	// third distinct ISO week with a published post. PublishWeeks counts those
	// weeks.
	FirstPostAt  *time.Time `bun:"first_post_at"`
	RegularAt    *time.Time `bun:"regular_at"`
	PublishWeeks int        `bun:"publish_weeks"`
	// LastActivityAt is the latest post created or published or asset created,
	// the same definition as TenantPulse.
	LastActivityAt *time.Time `bun:"last_activity_at"`
	// BrokenPlatforms lists the platforms of inactive, non-deleted accounts.
	BrokenSocial    int    `bun:"broken_social"`
	BrokenPlatforms string `bun:"broken_platforms"`
	// FailedPosts24h counts posts that failed in the last 24h, on the newest
	// failure's platform.
	FailedPosts24h      int    `bun:"failed_posts_24h"`
	LastFailurePlatform string `bun:"last_failure_platform"`
	// Drafts counts posts written but not scheduled (draft, ready to publish).
	Drafts int `bun:"drafts"`
}

// LifecycleRepository reads the lifecycle signals from the Ogen DB. It shares
// the tenant repository's schema probing, so an older Ogen schema degrades a
// column to NULL or 0 instead of failing the query.
type LifecycleRepository struct{ r *tenantRepository }

func NewLifecycleRepository(db *bun.DB) *LifecycleRepository {
	return &LifecycleRepository{r: &tenantRepository{db: db}}
}

func (l *LifecycleRepository) Available() bool { return l.r.db != nil }

// Signals returns every tenant's lifecycle signals, oldest first.
func (l *LifecycleRepository) Signals(ctx context.Context) ([]LifecycleSignal, error) {
	if l.r.db == nil {
		return nil, ErrUnavailable
	}
	// Every %s is an allowlisted expression chosen from the live schema, never
	// user input.
	tenantCols := l.r.tableColumns(ctx, "tenants")
	statusExpr, deletedExpr := "'active'", "NULL::timestamptz"
	if tenantCols["status"] {
		statusExpr = "COALESCE(t.status, 'active')"
	}
	if tenantCols["deleted_at"] {
		deletedExpr = "t.deleted_at"
	}
	socialCols := l.r.tableColumns(ctx, "social_accounts")
	connectedExpr := "NULL::timestamptz"
	switch {
	case socialCols["connected_at"]:
		connectedExpr = "min(sa.connected_at)"
	case socialCols["created_at"]:
		connectedExpr = "min(sa.created_at)"
	}
	postCols := l.r.tableColumns(ctx, "posts")
	draftsExpr := "0"
	if postCols["status"] {
		draftsExpr = "(SELECT count(*) FROM posts po WHERE po.tenant_id = t.id AND po.status IN ('draft', 'ready_for_publish'))"
	}
	platformExpr, platformJoin := "''", ""
	if postCols["platform_id"] {
		platformExpr, platformJoin = "COALESCE(pl.name, '')", "LEFT JOIN platforms pl ON pl.id = po.platform_id"
	}
	failed24h, newestFirst := "false", "1"
	if postCols["failure_reason"] && postCols["updated_at"] {
		failed24h = `po.tenant_id = t.id
		AND po.failure_reason IS NOT NULL AND po.failure_reason <> ''
		AND po.updated_at >= now() - interval '24 hours'`
		newestFirst = "po.updated_at DESC"
	}

	query := fmt.Sprintf(`
		WITH weeks AS (
			SELECT tenant_id, date_trunc('week', published_at AT TIME ZONE 'UTC') AS week,
			       min(published_at) AS first_at
			FROM posts
			WHERE published_at IS NOT NULL
			GROUP BY 1, 2
		), ranked AS (
			SELECT tenant_id, first_at,
			       row_number() OVER (PARTITION BY tenant_id ORDER BY week) AS n
			FROM weeks
		), publishing AS (
			SELECT tenant_id,
			       count(*)                          AS publish_weeks,
			       min(first_at)                     AS first_post_at,
			       min(first_at) FILTER (WHERE n = 3) AS regular_at
			FROM ranked
			GROUP BY tenant_id
		), social AS (
			SELECT sa.tenant_id, %[3]s AS first_social_at,
			       count(*) FILTER (WHERE sa.is_active = false AND sa.deleted_at IS NULL) AS broken_social,
			       COALESCE(string_agg(DISTINCT sa.platform, ', ')
			           FILTER (WHERE sa.is_active = false AND sa.deleted_at IS NULL), '') AS broken_platforms
			FROM social_accounts sa
			GROUP BY sa.tenant_id
		)
		SELECT
			t.id, t.name, %[1]s AS status, t.created_at, %[2]s AS deleted_at,
			s.first_social_at,
			p.first_post_at, p.regular_at, COALESCE(p.publish_weeks, 0) AS publish_weeks,
			-- GREATEST skips NULLs, so either source alone is enough.
			GREATEST(
				(SELECT max(GREATEST(po.created_at, po.published_at)) FROM posts po
					WHERE po.tenant_id = t.id),
				(SELECT max(a.created_at) FROM assets a WHERE a.tenant_id = t.id)
			) AS last_activity_at,
			COALESCE(s.broken_social, 0) AS broken_social,
			COALESCE(s.broken_platforms, '') AS broken_platforms,
			(SELECT count(*) FROM posts po WHERE %[6]s) AS failed_posts_24h,
			COALESCE(f.platform, '') AS last_failure_platform,
			%[4]s AS drafts
		FROM tenants t
		LEFT JOIN publishing p ON p.tenant_id = t.id
		LEFT JOIN social s ON s.tenant_id = t.id
		LEFT JOIN LATERAL (
			SELECT %[5]s AS platform
			FROM posts po %[7]s
			WHERE %[6]s
			ORDER BY %[8]s
			LIMIT 1
		) f ON true
		ORDER BY t.created_at`,
		statusExpr, deletedExpr, connectedExpr, draftsExpr, platformExpr, failed24h, platformJoin, newestFirst)

	var rows []LifecycleSignal
	if err := l.r.db.NewRaw(query).Scan(ctx, &rows); err != nil {
		return nil, err
	}
	return rows, nil
}
