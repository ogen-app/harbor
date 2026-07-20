package handlers

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"

	"github.com/ogen-app/harbor/src/auth"
	"github.com/ogen-app/harbor/src/logging"
	"github.com/ogen-app/harbor/src/models"
	"github.com/ogen-app/harbor/src/repository"
)

// sessionTTL is how long a session (and its cookie) stays valid. Mirrors ogen.
const sessionTTL = 7 * 24 * time.Hour

// GoogleVerifier is the slice of src/auth.Verifier this handler needs; kept as
// an interface so the handler is testable without hitting Google, and so a
// "login disabled" state is a genuinely nil interface (see server wiring).
type GoogleVerifier interface {
	ExchangeCode(ctx context.Context, code string) (*auth.Identity, error)
}

// AuthHandler owns the login lifecycle: Google code exchange, the allowlist
// gate, session issuance, the current-user probe, and logout.
type AuthHandler struct {
	users          repository.UserRepository
	sessions       repository.SessionRepository
	verifier       GoogleVerifier
	allowed        map[string]struct{}
	googleClientID string
	cookieName     string
}

// NewAuthHandler builds the handler. allowedEmails is normalised to a
// lowercase set. verifier may be nil (Google login disabled).
func NewAuthHandler(
	users repository.UserRepository,
	sessions repository.SessionRepository,
	verifier GoogleVerifier,
	allowedEmails []string,
	googleClientID, cookieName string,
) *AuthHandler {
	allowed := make(map[string]struct{}, len(allowedEmails))
	for _, e := range allowedEmails {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			allowed[e] = struct{}{}
		}
	}
	return &AuthHandler{
		users:          users,
		sessions:       sessions,
		verifier:       verifier,
		allowed:        allowed,
		googleClientID: googleClientID,
		cookieName:     cookieName,
	}
}

// Register mounts the auth routes. requireAuth guards the current-user probe.
func (h *AuthHandler) Register(app *fiber.App, requireAuth fiber.Handler) {
	app.Get("/api/auth/config", h.Config)
	app.Post("/api/auth/google", h.Google)
	app.Post("/api/auth/logout", h.Logout)
	app.Get("/api/auth/me", requireAuth, h.Me)
}

// userView is the public projection of a user (no google_sub/timestamps).
type userView struct {
	ID      string `json:"id"`
	Email   string `json:"email"`
	Name    string `json:"name"`
	Picture string `json:"picture"`
}

func viewOf(u *models.User) userView {
	return userView{ID: u.ID, Email: u.Email, Name: u.Name, Picture: u.Picture}
}

// Config exposes the public Google client id so the static UI can initialise the
// sign-in popup without a rebuild. Empty clientId ⇒ login disabled in the UI.
func (h *AuthHandler) Config(c *fiber.Ctx) error {
	return c.JSON(fiber.Map{"googleClientId": h.googleClientID})
}

type googleLoginRequest struct {
	Code string `json:"code"`
}

// Google exchanges the popup authorization code, enforces the allowlist, upserts
// the user, and issues a session cookie.
func (h *AuthHandler) Google(c *fiber.Ctx) error {
	if h.verifier == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "google login not configured")
	}

	var req googleLoginRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	if strings.TrimSpace(req.Code) == "" {
		return fiber.NewError(fiber.StatusBadRequest, "missing authorization code")
	}

	identity, err := h.verifier.ExchangeCode(c.Context(), req.Code)
	if err != nil {
		slog.WarnContext(c.Context(), "google code exchange failed",
			logging.AttrComponent, "auth", logging.AttrError, err)
		return fiber.NewError(fiber.StatusUnauthorized, "google authentication failed")
	}
	if !identity.EmailVerified {
		return fiber.NewError(fiber.StatusForbidden, "email not verified by Google")
	}
	if _, ok := h.allowed[identity.Email]; !ok {
		slog.WarnContext(c.Context(), "login denied: email not on allowlist",
			logging.AttrComponent, "auth", "email", identity.Email)
		return fiber.NewError(fiber.StatusForbidden, "email_not_allowed")
	}

	user := &models.User{
		ID:        uuid.NewString(),
		GoogleSub: identity.Sub,
		Email:     identity.Email,
		Name:      identity.Name,
		Picture:   identity.Picture,
	}
	if err := h.users.Upsert(c.Context(), user); err != nil {
		return err
	}

	token, err := models.NewSessionToken()
	if err != nil {
		return err
	}
	session := &models.Session{
		ID:        token,
		UserID:    user.ID,
		ExpiresAt: time.Now().UTC().Add(sessionTTL),
	}
	if err := h.sessions.Create(c.Context(), session); err != nil {
		return err
	}

	h.setSessionCookie(c, token, session.ExpiresAt)
	slog.InfoContext(c.Context(), "login succeeded", logging.AttrComponent, "auth", "email", user.Email)
	return c.Status(fiber.StatusCreated).JSON(viewOf(user))
}

// Me returns the authenticated user (RequireAuth must run first).
func (h *AuthHandler) Me(c *fiber.Ctx) error {
	session, ok := sessionFrom(c)
	if !ok {
		return fiber.NewError(fiber.StatusUnauthorized, "authentication required")
	}
	user, err := h.users.GetByID(c.Context(), session.UserID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fiber.NewError(fiber.StatusUnauthorized, "user not found")
		}
		return err
	}
	return c.JSON(viewOf(user))
}

// Logout revokes the session (if any) and clears the cookie. Idempotent.
func (h *AuthHandler) Logout(c *fiber.Ctx) error {
	if token := c.Cookies(h.cookieName); token != "" {
		if _, err := h.sessions.Delete(c.Context(), token); err != nil {
			return err
		}
	}
	h.clearSessionCookie(c)
	return c.SendStatus(fiber.StatusNoContent)
}

// secureRequest reports whether the request arrived over HTTPS — directly or via
// a TLS-terminating proxy (X-Forwarded-Proto). The session cookie is marked
// Secure only then, so it is still stored over plain http://localhost in dev.
func secureRequest(c *fiber.Ctx) bool {
	if c.Protocol() == "https" {
		return true
	}
	return strings.EqualFold(c.Get("X-Forwarded-Proto"), "https")
}

func (h *AuthHandler) setSessionCookie(c *fiber.Ctx, token string, expires time.Time) {
	c.Cookie(&fiber.Cookie{
		Name:     h.cookieName,
		Value:    token,
		Path:     "/",
		Expires:  expires,
		HTTPOnly: true,
		Secure:   secureRequest(c),
		SameSite: "Lax",
	})
}

func (h *AuthHandler) clearSessionCookie(c *fiber.Ctx) {
	c.Cookie(&fiber.Cookie{
		Name:     h.cookieName,
		Value:    "",
		Path:     "/",
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
		HTTPOnly: true,
		Secure:   secureRequest(c),
		SameSite: "Lax",
	})
}
