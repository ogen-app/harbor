package handlers

import (
	"database/sql"
	"errors"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/ogen-app/harbor/src/logging"
	"github.com/ogen-app/harbor/src/models"
	"github.com/ogen-app/harbor/src/repository/harbor"
)

// sessionLocalKey is the Fiber locals key under which RequireAuth stores the
// authenticated *models.Session for downstream handlers.
const sessionLocalKey = "session"

// RequireAuth rejects requests without a valid, non-expired session cookie. On
// success it stores the session under sessionLocalKey and the user id under
// logging.UserIDKey (so the slog ContextHandler tags every line). Mirrors
// ../ogen minus tenant scoping.
func RequireAuth(sessionRepo harbor.SessionRepository, cookieName string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		token := c.Cookies(cookieName)
		if token == "" {
			return fiber.NewError(fiber.StatusUnauthorized, "authentication required")
		}

		session, err := sessionRepo.GetByID(c.Context(), token)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return fiber.NewError(fiber.StatusUnauthorized, "invalid or expired session")
			}
			return err
		}

		if time.Now().UTC().After(session.ExpiresAt) {
			return fiber.NewError(fiber.StatusUnauthorized, "invalid or expired session")
		}

		c.Locals(sessionLocalKey, session)
		c.Locals(logging.UserIDKey, session.UserID)
		return c.Next()
	}
}

// sessionFrom returns the authenticated session stored by RequireAuth.
func sessionFrom(c *fiber.Ctx) (*models.Session, bool) {
	s, ok := c.Locals(sessionLocalKey).(*models.Session)
	return s, ok
}
