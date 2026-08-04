package handlers

import (
	"database/sql"
	"errors"
	"log/slog"
	"regexp"
	"strings"

	"github.com/gofiber/fiber/v2"

	"github.com/ogen-app/harbor/src/logging"
	"github.com/ogen-app/harbor/src/repository/ogen"
)

// templateKeyRe constrains a new template's key: a stable, url-safe slug
// (lowercase letters, digits, underscores) matching Ogen's existing keys
// ("welcome", "drip_day2", …).
var templateKeyRe = regexp.MustCompile(`^[a-z0-9_]{1,64}$`)

// EmailTemplatesHandler serves the Ogen email templates (CON-154) for the
// Settings → Email templates page. Reads are best-effort (a soft "unavailable"
// state when the Ogen pool is down); writes edit the seeded rows in place.
type EmailTemplatesHandler struct {
	templates ogen.EmailTemplateRepository
}

func NewEmailTemplatesHandler(templates ogen.EmailTemplateRepository) *EmailTemplatesHandler {
	return &EmailTemplatesHandler{templates: templates}
}

func (h *EmailTemplatesHandler) Register(app *fiber.App, requireAuth fiber.Handler) {
	app.Get("/api/email-templates", requireAuth, h.List)
	app.Post("/api/email-templates", requireAuth, h.Create)
	app.Put("/api/email-templates/:key", requireAuth, h.Update)
}

// List godoc
// @Summary      List email templates
// @Description  Every editable email template from the Ogen control-plane, with
// @Description  its subject, HTML/text bodies, kind and version.
// @Tags         email-templates
// @Produce      json
// @Success      200  {object}  map[string]any
// @Router       /api/email-templates [get]
func (h *EmailTemplatesHandler) List(c *fiber.Ctx) error {
	if !h.templates.Available() {
		return c.JSON(fiber.Map{"templates": []ogen.EmailTemplate{}, "available": false, "error": "ogen database not configured"})
	}
	rows, err := h.templates.List(c.Context())
	if err != nil {
		slog.WarnContext(c.Context(), "list email templates failed", logging.AttrComponent, "email-templates", logging.AttrError, err)
		return c.JSON(fiber.Map{"templates": []ogen.EmailTemplate{}, "available": false, "error": "failed to load templates"})
	}
	return c.JSON(fiber.Map{"templates": rows, "available": true})
}

// Create godoc
// @Summary      Create an email template
// @Description  Inserts a new template (empty body, transactional kind) with the
// @Description  given id and subject. 409 if the id is taken.
// @Tags         email-templates
// @Accept       json
// @Produce      json
// @Success      201  {object}  ogen.EmailTemplate
// @Router       /api/email-templates [post]
func (h *EmailTemplatesHandler) Create(c *fiber.Ctx) error {
	if !h.templates.Available() {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"error": "ogen database not configured"})
	}
	var body struct {
		Key     string `json:"key"`
		Subject string `json:"subject"`
		Kind    string `json:"kind"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}
	key := strings.TrimSpace(body.Key)
	subject := strings.TrimSpace(body.Subject)
	kind := strings.TrimSpace(body.Kind)
	if !templateKeyRe.MatchString(key) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "id must be 1–64 characters of lowercase letters, digits or underscores"})
	}
	if subject == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "title is required"})
	}
	if kind != "transactional" && kind != "marketing" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "type must be transactional or marketing"})
	}
	row, err := h.templates.Create(c.Context(), key, subject, kind)
	if errors.Is(err, ogen.ErrDuplicateKey) {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "a template with this id already exists"})
	}
	if err != nil {
		slog.ErrorContext(c.Context(), "create email template failed", logging.AttrComponent, "email-templates", logging.AttrError, err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to create template"})
	}
	return c.Status(fiber.StatusCreated).JSON(row)
}

// Update godoc
// @Summary      Update an email template
// @Description  Saves a template's subject and HTML body. 404 if the id is
// @Description  unknown.
// @Tags         email-templates
// @Accept       json
// @Produce      json
// @Param        key  path  string  true  "Template key"
// @Success      200  {object}  ogen.EmailTemplate
// @Router       /api/email-templates/{key} [put]
func (h *EmailTemplatesHandler) Update(c *fiber.Ctx) error {
	if !h.templates.Available() {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"error": "ogen database not configured"})
	}
	key := c.Params("key")
	if !templateKeyRe.MatchString(key) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "id must be 1–64 characters of lowercase letters, digits or underscores"})
	}
	var body struct {
		Subject string `json:"subject"`
		HTML    string `json:"html"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}
	subject := strings.TrimSpace(body.Subject)
	if subject == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "title is required"})
	}
	row, err := h.templates.Update(c.Context(), key, subject, body.HTML)
	if errors.Is(err, sql.ErrNoRows) {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "template not found"})
	}
	if err != nil {
		slog.ErrorContext(c.Context(), "update email template failed", logging.AttrComponent, "email-templates", logging.AttrError, err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to save template"})
	}
	return c.JSON(row)
}
