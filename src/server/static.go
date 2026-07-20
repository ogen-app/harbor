package server

import (
	"io/fs"
	"path"
	"strings"

	"github.com/gofiber/fiber/v2"
)

// registerUI mounts the embedded static export as a catch-all fallback. It runs
// after the API routes, so anything not claimed by a handler is treated as a UI
// request. Unknown /api/* paths and non-GET methods 404 (as JSON, via the error
// handler) rather than being served the SPA shell.
func registerUI(app *fiber.App, dist fs.FS) {
	app.Use(func(c *fiber.Ctx) error {
		if strings.HasPrefix(c.Path(), "/api/") {
			return fiber.ErrNotFound
		}
		if c.Method() != fiber.MethodGet && c.Method() != fiber.MethodHead {
			return fiber.ErrNotFound
		}
		return serveUI(c, dist)
	})
}

// serveUI resolves a request path against the static export. A Next.js export
// (trailingSlash:false) emits per-route files like `audits.html`, so for
// `/audits` we try the raw path, then `.html`, then `<path>/index.html`, and
// finally fall back to `index.html`. The whole tree is embedded in memory, so
// reading a file is cheap.
func serveUI(c *fiber.Ctx, dist fs.FS) error {
	reqPath := strings.TrimPrefix(path.Clean("/"+c.Path()), "/")

	for _, name := range candidates(reqPath) {
		b, err := fs.ReadFile(dist, name)
		if err != nil {
			continue
		}
		if ext := strings.TrimPrefix(path.Ext(name), "."); ext != "" {
			c.Type(ext)
		}
		// Next content-hashes everything under _next/, so it is immutable.
		if strings.HasPrefix(reqPath, "_next/") {
			c.Set(fiber.HeaderCacheControl, "public, max-age=31536000, immutable")
		}
		return c.Send(b)
	}
	return fiber.ErrNotFound
}

// candidates returns the file names to try, in order, for a cleaned request
// path (no leading slash).
func candidates(reqPath string) []string {
	if reqPath == "" || reqPath == "." {
		return []string{"index.html"}
	}
	return []string{
		reqPath,
		reqPath + ".html",
		path.Join(reqPath, "index.html"),
		"index.html", // SPA fallback for unknown routes
	}
}
