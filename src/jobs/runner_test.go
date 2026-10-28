package jobs

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/ogen-app/harbor/src/database"
)

// Two replicas ticking the same job at once: exactly one runs it, and the lock
// is free again afterwards. Needs HARBOR_TEST_DSN.
func TestRunOnceTakesTheLock(t *testing.T) {
	dsn := os.Getenv("HARBOR_TEST_DSN")
	if dsn == "" {
		t.Skip("HARBOR_TEST_DSN not set")
	}
	db, err := database.New(dsn, false)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	a, b := NewRunner(db), NewRunner(db)
	name := "test.lock." + time.Now().Format(time.RFC3339Nano)

	started, release := make(chan struct{}), make(chan struct{})
	slow := Job{Name: name, Run: func(context.Context) error {
		close(started)
		<-release
		return nil
	}}
	done := make(chan bool, 1)
	go func() { done <- a.RunOnce(t.Context(), slow) }()
	select {
	case <-started:
	case <-done:
		t.Fatal("the first replica could not take the lock")
	case <-time.After(5 * time.Second):
		t.Fatal("the job never started")
	}

	ran := false
	other := Job{Name: name, Run: func(context.Context) error { ran = true; return nil }}
	if b.RunOnce(t.Context(), other) || ran {
		t.Fatal("a second replica ran the job while the first held it")
	}
	close(release)
	select {
	case ok := <-done:
		if !ok {
			t.Fatal("the first replica did not run the job")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("first run never finished")
	}
	if !b.RunOnce(t.Context(), other) || !ran {
		t.Fatal("the lock was not released")
	}
}
