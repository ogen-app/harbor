// Package auth verifies Google sign-ins. The browser runs the Google Identity
// Services popup in "code" mode and hands us a one-time authorization code; we
// exchange it (server-side, with the client secret) for tokens and validate the
// resulting ID token against Google's keys.
package auth

import (
	"context"
	"fmt"
	"strings"

	"golang.org/x/oauth2"
	googleendpoint "golang.org/x/oauth2/google"
	"google.golang.org/api/idtoken"
)

// Identity is the verified subset of a Google account Harbor cares about.
type Identity struct {
	Sub           string
	Email         string
	EmailVerified bool
	Name          string
	Picture       string
}

// Verifier exchanges authorization codes and validates ID tokens for one OAuth
// client.
type Verifier struct {
	clientID string
	cfg      *oauth2.Config
}

// NewVerifier builds a verifier for the given Web OAuth client. Returns nil when
// credentials are absent, so callers can treat "Google login disabled" as a
// nil verifier.
func NewVerifier(clientID, clientSecret string) *Verifier {
	if clientID == "" || clientSecret == "" {
		return nil
	}
	return &Verifier{
		clientID: clientID,
		cfg: &oauth2.Config{
			ClientID:     clientID,
			ClientSecret: clientSecret,
			Endpoint:     googleendpoint.Endpoint,
			// The GIS popup code client posts the code back to the opener; the
			// server-side exchange uses the special "postmessage" redirect.
			RedirectURL: "postmessage",
			Scopes:      []string{"openid", "email", "profile"},
		},
	}
}

// ExchangeCode swaps the popup's one-time code for tokens and returns the
// identity carried (and cryptographically verified) by the id_token.
func (v *Verifier) ExchangeCode(ctx context.Context, code string) (*Identity, error) {
	tok, err := v.cfg.Exchange(ctx, code)
	if err != nil {
		return nil, fmt.Errorf("exchange code: %w", err)
	}
	raw, ok := tok.Extra("id_token").(string)
	if !ok || raw == "" {
		return nil, fmt.Errorf("token response had no id_token")
	}

	// idtoken.Validate checks the signature against Google's JWKS and verifies
	// aud == clientID, iss ∈ {accounts.google.com, https://accounts.google.com},
	// and expiry.
	payload, err := idtoken.Validate(ctx, raw, v.clientID)
	if err != nil {
		return nil, fmt.Errorf("validate id_token: %w", err)
	}

	id := &Identity{Sub: payload.Subject}
	if s, ok := payload.Claims["email"].(string); ok {
		id.Email = strings.ToLower(strings.TrimSpace(s))
	}
	if b, ok := payload.Claims["email_verified"].(bool); ok {
		id.EmailVerified = b
	}
	if s, ok := payload.Claims["name"].(string); ok {
		id.Name = s
	}
	if s, ok := payload.Claims["picture"].(string); ok {
		id.Picture = s
	}
	return id, nil
}
