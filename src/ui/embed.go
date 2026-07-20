// Package ui embeds the compiled Next.js static export so Harbor ships as a
// single self-contained binary — API and UI on one port.
//
// The export is produced by `make ui` (which runs `next build` with
// NEXT_OUTPUT=export in ../../ui and copies the resulting `out/` here to
// `dist/`). The `dist/index.html` committed alongside this file is a
// placeholder so `go build` succeeds before the UI has ever been built; a real
// `make ui` overwrites it. The `all:` prefix is required so Next's `_next/`
// asset directory (leading underscore) is included in the embed.
package ui

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// Dist returns the embedded static export rooted at the export directory
// (so "index.html" resolves, not "dist/index.html").
func Dist() (fs.FS, error) {
	return fs.Sub(dist, "dist")
}
