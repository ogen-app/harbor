package handlers

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"

	"github.com/ogen-app/harbor/src/auth"
	"github.com/ogen-app/harbor/src/models"
)

// ── fakes ─────────────────────────────────────────────────────────────────────

type fakeUserRepo struct {
	byID    map[string]*models.User
	byEmail map[string]*models.User
}

func newFakeUserRepo() *fakeUserRepo {
	return &fakeUserRepo{byID: map[string]*models.User{}, byEmail: map[string]*models.User{}}
}

func (f *fakeUserRepo) GetByID(_ context.Context, id string) (*models.User, error) {
	if u, ok := f.byID[id]; ok {
		return u, nil
	}
	return nil, sql.ErrNoRows
}

func (f *fakeUserRepo) GetByEmail(_ context.Context, email string) (*models.User, error) {
	if u, ok := f.byEmail[email]; ok {
		return u, nil
	}
	return nil, sql.ErrNoRows
}

func (f *fakeUserRepo) Upsert(_ context.Context, u *models.User) error {
	if existing, ok := f.byEmail[u.Email]; ok {
		u.ID = existing.ID // mirror the DB returning the canonical id
	}
	cp := *u
	f.byID[u.ID] = &cp
	f.byEmail[u.Email] = &cp
	return nil
}

type fakeSessionRepo struct{ m map[string]*models.Session }

func newFakeSessionRepo() *fakeSessionRepo { return &fakeSessionRepo{m: map[string]*models.Session{}} }

func (f *fakeSessionRepo) Create(_ context.Context, s *models.Session) error {
	cp := *s
	f.m[s.ID] = &cp
	return nil
}

func (f *fakeSessionRepo) GetByID(_ context.Context, id string) (*models.Session, error) {
	if s, ok := f.m[id]; ok {
		return s, nil
	}
	return nil, sql.ErrNoRows
}

func (f *fakeSessionRepo) Delete(_ context.Context, id string) (bool, error) {
	_, ok := f.m[id]
	delete(f.m, id)
	return ok, nil
}

type fakeVerifier struct {
	id  *auth.Identity
	err error
}

func (f fakeVerifier) ExchangeCode(_ context.Context, _ string) (*auth.Identity, error) {
	return f.id, f.err
}

// ── harness ───────────────────────────────────────────────────────────────────

const testCookie = "harbor_session"

func newAuthApp(t *testing.T, verifier GoogleVerifier, allowed []string) (*fiber.App, *fakeSessionRepo) {
	t.Helper()
	app := fiber.New(fiber.Config{ErrorHandler: func(c *fiber.Ctx, err error) error {
		code := fiber.StatusInternalServerError
		var fe *fiber.Error
		if errors.As(err, &fe) {
			code = fe.Code
		}
		return c.Status(code).JSON(fiber.Map{"error": err.Error()})
	}})
	sessions := newFakeSessionRepo()
	h := NewAuthHandler(newFakeUserRepo(), sessions, verifier, allowed, "client-123", testCookie)
	h.Register(app, RequireAuth(sessions, testCookie))
	return app, sessions
}

type result struct {
	status    int
	body      string
	setCookie string
}

// do issues a request through the fiber app and returns status/body/Set-Cookie.
// cookie, when non-empty, is sent as the raw Cookie header (e.g. "name=value").
func do(t *testing.T, app *fiber.App, method, path, body, cookie string) result {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, r)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return result{status: resp.StatusCode, body: string(b), setCookie: resp.Header.Get("Set-Cookie")}
}

// cookiePair extracts "name=value" from a Set-Cookie header for reuse as a
// request Cookie header.
func cookiePair(setCookie string) string {
	return strings.SplitN(setCookie, ";", 2)[0]
}

func TestGoogleLoginAllowlistAndSession(t *testing.T) {
	identity := &auth.Identity{
		Sub: "google-sub-1", Email: "serhii@example.com", EmailVerified: true,
		Name: "Serhii H", Picture: "https://pic",
	}

	t.Run("disabled when no verifier", func(t *testing.T) {
		app, _ := newAuthApp(t, nil, []string{"serhii@example.com"})
		got := do(t, app, "POST", "/api/auth/google", `{"code":"x"}`, "")
		if got.status != fiber.StatusServiceUnavailable {
			t.Fatalf("status = %d, want 503", got.status)
		}
	})

	t.Run("denied when email not allowlisted", func(t *testing.T) {
		app, _ := newAuthApp(t, fakeVerifier{id: identity}, []string{"someone-else@example.com"})
		got := do(t, app, "POST", "/api/auth/google", `{"code":"x"}`, "")
		if got.status != fiber.StatusForbidden {
			t.Fatalf("status = %d, want 403", got.status)
		}
		if !strings.Contains(got.body, "email_not_allowed") {
			t.Fatalf("body = %q, want email_not_allowed", got.body)
		}
	})

	t.Run("allowed: session issued, /me works, logout revokes", func(t *testing.T) {
		// Uppercase allowlist entry exercises case-insensitive matching.
		app, sessions := newAuthApp(t, fakeVerifier{id: identity}, []string{"Serhii@Example.com"})

		login := do(t, app, "POST", "/api/auth/google", `{"code":"x"}`, "")
		if login.status != fiber.StatusCreated {
			t.Fatalf("login status = %d, want 201 (body %q)", login.status, login.body)
		}
		if !strings.Contains(login.setCookie, testCookie+"=") || !strings.Contains(login.setCookie, "HttpOnly") {
			t.Fatalf("missing HttpOnly session cookie: %q", login.setCookie)
		}
		if !strings.Contains(login.body, `"email":"serhii@example.com"`) {
			t.Fatalf("login body = %q, want user view with email", login.body)
		}
		if len(sessions.m) != 1 {
			t.Fatalf("expected 1 stored session, got %d", len(sessions.m))
		}
		jar := cookiePair(login.setCookie)

		me := do(t, app, "GET", "/api/auth/me", "", jar)
		if me.status != fiber.StatusOK {
			t.Fatalf("/me status = %d, want 200 (body %q)", me.status, me.body)
		}

		logout := do(t, app, "POST", "/api/auth/logout", "", jar)
		if logout.status != fiber.StatusNoContent {
			t.Fatalf("logout status = %d, want 204", logout.status)
		}
		if len(sessions.m) != 0 {
			t.Fatalf("expected session revoked, %d remain", len(sessions.m))
		}

		dead := do(t, app, "GET", "/api/auth/me", "", jar)
		if dead.status != fiber.StatusUnauthorized {
			t.Fatalf("/me after logout = %d, want 401", dead.status)
		}
	})

	t.Run("me requires auth", func(t *testing.T) {
		app, _ := newAuthApp(t, fakeVerifier{id: identity}, []string{"serhii@example.com"})
		got := do(t, app, "GET", "/api/auth/me", "", "")
		if got.status != fiber.StatusUnauthorized {
			t.Fatalf("/me without cookie = %d, want 401", got.status)
		}
	})
}
