package ogen

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"maps"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/ogen-app/harbor/src/database"
)

func TestAllocationDriversUnavailable(t *testing.T) {
	d := NewAllocationDrivers(nil)
	if _, err := d.ActiveTenants(t.Context(), time.Now()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
}

// TestAllocationDrivers runs the driver queries against a minimal stand-in of
// Ogen's schema. Skips unless HARBOR_TEST_DSN is set.
func TestAllocationDrivers(t *testing.T) {
	dsn := os.Getenv("HARBOR_TEST_DSN")
	if dsn == "" {
		t.Skip("HARBOR_TEST_DSN not set")
	}
	admin, err := database.New(dsn, false)
	if err != nil {
		t.Fatal(err)
	}
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	name := "ogen_test_" + hex.EncodeToString(b)
	if _, err := admin.Exec("CREATE DATABASE " + name); err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(dsn)
	u.Path = "/" + name
	db, err := database.New(u.String(), false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = db.Close()
		_, _ = admin.Exec("DROP DATABASE IF EXISTS " + name + " WITH (FORCE)")
		_ = admin.Close()
	})
	if _, err := db.Exec(`
		CREATE TABLE tenants (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active',
			created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMPTZ);
		CREATE TABLE posts (id SERIAL, tenant_id TEXT, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, published_at TIMESTAMPTZ);
		CREATE TABLE email_logs (id SERIAL, tenant_id TEXT, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL);
		INSERT INTO tenants VALUES
			('default',   'active',    '2026-01-01', '2026-01-01', NULL),
			('live',      'active',    '2026-01-01', '2026-01-01', NULL),
			('new',       'active',    '2026-10-20', '2026-10-20', NULL),
			('future',    'active',    '2026-11-02', '2026-11-02', NULL),
			('susp-old',  'suspended', '2026-01-01', '2026-09-10', NULL),
			('susp-mid',  'suspended', '2026-01-01', '2026-10-12', NULL),
			('gone-old',  'deleted',   '2026-01-01', '2026-09-01', '2026-09-01'),
			('gone-mid',  'deleted',   '2026-01-01', '2026-10-05', '2026-10-05');
		INSERT INTO posts (tenant_id, status, created_at, published_at) VALUES
			('live', 'published', '2026-09-28', '2026-10-02'),
			('live', 'published', '2026-10-03', NULL),
			('live', 'draft',     '2026-10-03', NULL),
			('new',  'published', '2026-10-30', '2026-11-01'),
			('new',  'published', '2026-10-25', '2026-10-25');
		INSERT INTO email_logs (tenant_id, status, created_at) VALUES
			('live', 'sent', '2026-10-01'), ('live', 'sent', '2026-10-31 23:59'),
			('live', 'failed', '2026-10-02'), ('new', 'sent', '2026-11-01'), (NULL, 'sent', '2026-10-02');`); err != nil {
		t.Fatal(err)
	}

	d := NewAllocationDrivers(db)
	oct := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	check := func(label string, got map[string]int64, err error, want map[string]int64) {
		t.Helper()
		if err != nil {
			t.Fatalf("%s: %v", label, err)
		}
		if !maps.Equal(got, want) {
			t.Errorf("%s = %v, want %v", label, got, want)
		}
	}
	got, err := d.ActiveTenants(t.Context(), oct)
	check("active tenants", got, err, map[string]int64{"live": 1, "new": 1, "susp-mid": 1, "gone-mid": 1})
	got, err = d.PostsPublished(t.Context(), oct)
	check("posts", got, err, map[string]int64{"live": 2, "new": 1})
	got, err = d.EmailsSent(t.Context(), oct)
	check("emails", got, err, map[string]int64{"live": 2})
}
