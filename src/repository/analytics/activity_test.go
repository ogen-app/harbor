package analytics

import (
	"context"
	"errors"
	"testing"
)

// A nil pool is the "analytics unconfigured" case; activity reads must report it
// as ErrUnavailable rather than panicking on a nil *bun.DB.
func TestActivityRepositoryUnavailable(t *testing.T) {
	r := NewActivityRepository(nil)
	if r.Available() {
		t.Fatal("nil pool should report unavailable")
	}
	if _, err := r.RecentActivity(context.Background(), "t1", 15); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("RecentActivity err = %v, want ErrUnavailable", err)
	}
	if _, err := r.ActivitySeries(context.Background(), "t1", 90); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("ActivitySeries err = %v, want ErrUnavailable", err)
	}
}
