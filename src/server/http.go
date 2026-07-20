package server

import (
	"errors"
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/ogen-app/harbor/src/logging"
)

// defaultErrorHandler renders every error as JSON and logs 5xx with request
// context. 4xx is a client problem, not a server fault, so it is not logged as
// an error here (it still shows in the access log).
func defaultErrorHandler(c *fiber.Ctx, err error) error {
	code := fiber.StatusInternalServerError
	var fe *fiber.Error
	if errors.As(err, &fe) {
		code = fe.Code
	}
	if code >= 500 {
		slog.ErrorContext(c.Context(), "request failed",
			logging.AttrComponent, "http",
			"method", c.Method(),
			"path", c.Path(),
			"status", code,
			logging.AttrError, err)
	}
	return c.Status(code).JSON(fiber.Map{"error": err.Error()})
}

// accessLog logs one structured line per request (component=http) with method,
// path, status, latency, response size, and client IP. 5xx is logged at ERROR.
func accessLog() fiber.Handler {
	return func(c *fiber.Ctx) error {
		start := time.Now()
		chainErr := c.Next()
		if chainErr != nil {
			if herr := c.App().ErrorHandler(c, chainErr); herr != nil {
				_ = c.SendStatus(fiber.StatusInternalServerError)
			}
		}

		status := c.Response().StatusCode()
		level := slog.LevelInfo
		if status >= 500 {
			level = slog.LevelError
		}
		respBytes := 0
		if !c.Response().IsBodyStream() {
			respBytes = len(c.Response().Body())
		}
		slog.Default().LogAttrs(c.Context(), level, "request",
			slog.String(logging.AttrComponent, "http"),
			slog.String("method", c.Method()),
			slog.String("path", c.Path()),
			slog.Int("status", status),
			slog.Int64("latency_ms", time.Since(start).Milliseconds()),
			slog.Int("bytes", respBytes),
			slog.String("ip", c.IP()),
		)
		return nil
	}
}
