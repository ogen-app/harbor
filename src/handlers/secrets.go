package handlers

import (
	"errors"
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v2"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/ogen-app/harbor/src/logging"
	"github.com/ogen-app/harbor/src/repository/ogensecrets"
)

// SecretsHandler is the REST surface Harbor's UI calls to manage Ogen's
// third-party API keys. It is a thin adapter over the ogensecrets gRPC client —
// all crypto, the name allowlist, and the hot-reload hooks live in Ogen behind
// the wire. Plaintext only enters via PUT bodies and never leaves: List/Get
// return metadata only, and errors never echo the submitted value.
type SecretsHandler struct {
	client *ogensecrets.Client
}

func NewSecretsHandler(client *ogensecrets.Client) *SecretsHandler {
	return &SecretsHandler{client: client}
}

// Register mounts the secrets routes behind auth. Only signed-in Harbor
// operators may reach them; Harbor→Ogen is separately authenticated by the
// shared gRPC token.
func (h *SecretsHandler) Register(app *fiber.App, requireAuth fiber.Handler) {
	app.Get("/api/secrets", requireAuth, h.List)
	app.Put("/api/secrets/:name", requireAuth, h.Put)
	app.Delete("/api/secrets/:name", requireAuth, h.Delete)
}

type secretPutRequest struct {
	Value string `json:"value"`
}

// listResponse mirrors the Ogen-DB status pattern: `available` distinguishes a
// down/unconfigured secrets service from a genuinely empty allowlist, so the UI
// can render a soft "unavailable" state instead of an error.
type listResponse struct {
	Available bool                     `json:"available"`
	Secrets   []ogensecrets.SecretMeta `json:"secrets"`
}

// List godoc
// @Summary  List secret slots (metadata only)
// @Tags     secrets
// @Produce  json
// @Success  200  {object}  listResponse
// @Router   /api/secrets [get]
func (h *SecretsHandler) List(c *fiber.Ctx) error {
	start := time.Now()
	out, err := h.client.List(c.Context())
	logSecrets(c, "", start, err)
	if err != nil {
		// A down/unconfigured upstream is a soft state, not a 5xx: return an
		// empty list flagged unavailable so the tab renders gracefully.
		if isUnavailable(err) {
			return c.JSON(listResponse{Available: false, Secrets: []ogensecrets.SecretMeta{}})
		}
		return mapSecretError(err)
	}
	if out == nil {
		out = []ogensecrets.SecretMeta{}
	}
	return c.JSON(listResponse{Available: true, Secrets: out})
}

// Put godoc
// @Summary  Create or rotate a secret
// @Tags     secrets
// @Accept   json
// @Produce  json
// @Param    name  path  string            true  "Secret name (allowlisted)"
// @Param    body  body  secretPutRequest  true  "Plaintext value"
// @Success  200   {object}  ogensecrets.SecretMeta
// @Success  201   {object}  ogensecrets.SecretMeta
// @Router   /api/secrets/{name} [put]
func (h *SecretsHandler) Put(c *fiber.Ctx) error {
	start := time.Now()
	name := c.Params("name")

	// Parse into a typed request so the value is scoped to this function and
	// never retained. A parse error returns a fixed-shape message (never the
	// body) to avoid echoing anything sensitive.
	var req secretPutRequest
	if err := c.BodyParser(&req); err != nil {
		logSecrets(c, name, start, err)
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}

	meta, created, err := h.client.Set(c.Context(), name, req.Value)
	logSecrets(c, name, start, err)
	if err != nil {
		return mapSecretError(err)
	}
	code := fiber.StatusOK
	if created {
		code = fiber.StatusCreated
	}
	return c.Status(code).JSON(meta)
}

// Delete godoc
// @Summary  Delete a secret
// @Tags     secrets
// @Param    name  path  string  true  "Secret name"
// @Success  204
// @Router   /api/secrets/{name} [delete]
func (h *SecretsHandler) Delete(c *fiber.Ctx) error {
	start := time.Now()
	name := c.Params("name")
	err := h.client.Delete(c.Context(), name)
	logSecrets(c, name, start, err)
	if err != nil {
		return mapSecretError(err)
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// isUnavailable reports whether err means "secrets service can't be reached
// right now" — either the client is unconfigured (nil) or the gRPC call failed
// with Unavailable (Ogen down / no listener).
func isUnavailable(err error) bool {
	return errors.Is(err, ogensecrets.ErrUnavailable) || status.Code(err) == codes.Unavailable
}

// mapSecretError translates client/gRPC errors to HTTP statuses. The gRPC codes
// come from Ogen's SecretsService (which mirrors the Store's error contract):
// InvalidArgument → 400, NotFound → 404. An Unauthenticated here means Harbor's
// shared token is wrong (operator-facing 502, logged upstream); Unavailable →
// 503; anything else → 500.
func mapSecretError(err error) error {
	if errors.Is(err, ogensecrets.ErrUnavailable) {
		return fiber.NewError(fiber.StatusServiceUnavailable, "secrets service unavailable")
	}
	st, ok := status.FromError(err)
	if !ok {
		return err
	}
	switch st.Code() {
	case codes.InvalidArgument:
		// Safe to surface: Ogen guarantees these messages never contain the value.
		return fiber.NewError(fiber.StatusBadRequest, st.Message())
	case codes.NotFound:
		return fiber.NewError(fiber.StatusNotFound, "secret not found")
	case codes.Unauthenticated:
		return fiber.NewError(fiber.StatusBadGateway, "secrets service authentication failed")
	case codes.Unavailable:
		return fiber.NewError(fiber.StatusServiceUnavailable, "secrets service unavailable")
	default:
		return fiber.NewError(fiber.StatusInternalServerError, "secrets request failed")
	}
}

// logSecrets emits a structured line with the secret name + status class and
// never the request body, the token, or any value.
func logSecrets(c *fiber.Ctx, name string, start time.Time, err error) {
	attrs := []any{logging.AttrComponent, "secrets", "method", c.Method(), "path", c.Path(), "duration_ms", time.Since(start).Milliseconds()}
	if name != "" {
		attrs = append(attrs, "name", name)
	}
	if err != nil {
		attrs = append(attrs, "code", status.Code(err).String())
	}
	slog.InfoContext(c.Context(), "secrets request", attrs...)
}
