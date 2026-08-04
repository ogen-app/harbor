package handlers

import (
	"github.com/gofiber/fiber/v2"

	"github.com/ogen-app/harbor/src/repository/ogen"
)

// EmailTemplatesHandler serves the Ogen email templates (CON-154) for the
// Settings → Email templates page. Best-effort: an unconfigured or unreachable
// Ogen pool is reported as a soft "unavailable" state so the page still renders.
type EmailTemplatesHandler struct {
	templates ogen.EmailTemplateRepository
}

func NewEmailTemplatesHandler(templates ogen.EmailTemplateRepository) *EmailTemplatesHandler {
	return &EmailTemplatesHandler{templates: templates}
}

func (h *EmailTemplatesHandler) Register(app *fiber.App, requireAuth fiber.Handler) {
	app.Get("/api/email-templates", requireAuth, h.List)
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
		return c.JSON(fiber.Map{"templates": []ogen.EmailTemplate{}, "available": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"templates": rows, "available": true})
}
