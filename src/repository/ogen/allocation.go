package ogen

import (
	"context"
	"fmt"
	"time"

	"github.com/uptrace/bun"
)

// DefaultTenantID is Ogen's platform fallback tenant: it holds backfilled
// pre-multi-tenant data and is never a customer, so cost allocation leaves it
// out of the even split.
const DefaultTenantID = "default"

// AllocationDrivers reads the per-tenant monthly quantities that shared cost
// allocation (CON-432) splits vendor bills by. Each method takes the month's
// first day (UTC) and returns tenant → quantity; a nil pool returns
// ErrUnavailable. Queries adapt to the live schema like the other reads here.
type AllocationDrivers struct{ r *tenantRepository }

func NewAllocationDrivers(db *bun.DB) *AllocationDrivers {
	return &AllocationDrivers{r: &tenantRepository{db: db}}
}

// ActiveTenants returns 1 for each tenant active during the month. Ogen keeps
// no status history, so this reads the current state: the tenant existed
// before the month ended, wasn't deleted before it began, and isn't suspended
// since before it began. Snapshots freeze the answer once a month closes.
func (d *AllocationDrivers) ActiveTenants(ctx context.Context, month time.Time) (map[string]int64, error) {
	if d.r.db == nil {
		return nil, ErrUnavailable
	}
	cols, err := d.columns(ctx, "tenants")
	if err != nil {
		return nil, err
	}
	where := "t.created_at < ?1 AND t.id <> ?2"
	if cols["deleted_at"] {
		where += " AND (t.deleted_at IS NULL OR t.deleted_at >= ?0)"
	}
	if cols["status"] && cols["updated_at"] {
		where += " AND NOT (t.status = 'suspended' AND t.updated_at < ?0)"
		where += " AND NOT (t.status = 'deleted' AND t.updated_at < ?0)"
	}
	var rows []tenantQuantity
	err = d.r.db.NewRaw(`SELECT t.id AS tenant_id, 1 AS quantity FROM tenants AS t WHERE `+where,
		month, month.AddDate(0, 1, 0), DefaultTenantID).Scan(ctx, &rows)
	return quantities(rows), err
}

// PostsPublished counts each tenant's posts published in the month, with the
// same "published" test and day as the Publishing statistics chart.
func (d *AllocationDrivers) PostsPublished(ctx context.Context, month time.Time) (map[string]int64, error) {
	if d.r.db == nil {
		return nil, ErrUnavailable
	}
	cols, err := d.columns(ctx, "posts")
	if err != nil {
		return nil, err
	}
	if !cols["tenant_id"] {
		return map[string]int64{}, nil
	}
	// Allowlisted column expressions, never user input (see
	// DailyPublishesByPlatform).
	dateExpr := "po.created_at"
	if cols["published_at"] {
		dateExpr = "COALESCE(po.published_at, po.created_at)"
	}
	publishedFilter := "po.created_at IS NOT NULL"
	if cols["status"] {
		publishedFilter = "po.status = 'published'"
	} else if cols["published_at"] {
		publishedFilter = "po.published_at IS NOT NULL"
	}
	var rows []tenantQuantity
	err = d.r.db.NewRaw(fmt.Sprintf(`
		SELECT po.tenant_id, count(*) AS quantity
		FROM posts AS po
		WHERE %[2]s AND po.tenant_id IS NOT NULL
		  AND %[1]s >= ? AND %[1]s < ?
		GROUP BY po.tenant_id`, dateExpr, publishedFilter),
		month, month.AddDate(0, 1, 0)).Scan(ctx, &rows)
	return quantities(rows), err
}

// EmailsSent counts each tenant's emails Ogen sent in the month (email_logs
// rows with status sent).
func (d *AllocationDrivers) EmailsSent(ctx context.Context, month time.Time) (map[string]int64, error) {
	if d.r.db == nil {
		return nil, ErrUnavailable
	}
	cols, err := d.columns(ctx, "email_logs")
	if err != nil {
		return nil, err
	}
	if !cols["tenant_id"] {
		return map[string]int64{}, nil
	}
	var rows []tenantQuantity
	err = d.r.db.NewRaw(`
		SELECT tenant_id, count(*) AS quantity
		FROM email_logs
		WHERE status = 'sent' AND tenant_id IS NOT NULL
		  AND created_at >= ? AND created_at < ?
		GROUP BY tenant_id`, month, month.AddDate(0, 1, 0)).Scan(ctx, &rows)
	return quantities(rows), err
}

// columns is tableColumns with its error: a driver must fail when the lookup
// fails (an unreachable pool, a timeout), never read it as "no such column" and
// store zeros. A table that doesn't exist yields an empty set.
func (d *AllocationDrivers) columns(ctx context.Context, table string) (map[string]bool, error) {
	var names []string
	if err := d.r.db.NewRaw(
		`SELECT column_name FROM information_schema.columns WHERE table_name = ?`,
		table).Scan(ctx, &names); err != nil {
		return nil, err
	}
	set := make(map[string]bool, len(names))
	for _, n := range names {
		set[n] = true
	}
	return set, nil
}

type tenantQuantity struct {
	TenantID string `bun:"tenant_id"`
	Quantity int64  `bun:"quantity"`
}

func quantities(rows []tenantQuantity) map[string]int64 {
	out := make(map[string]int64, len(rows))
	for _, row := range rows {
		out[row.TenantID] = row.Quantity
	}
	return out
}
