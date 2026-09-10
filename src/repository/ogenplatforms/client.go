// Package ogenplatforms is Harbor's gRPC client for Ogen's internal
// PlatformAdminService — the operator surface for the publishable
// social-platform catalog and its per-platform media/text limits (CON-292/293).
//
// Like ogensecrets/ogentenants (whose listener and shared bearer token this
// reuses), the client is best-effort: an unconfigured (empty addr/token) client
// is nil and every method returns ErrUnavailable, which the handler renders as
// a soft "unavailable" state. The bearer token is injected into outgoing gRPC
// metadata by a client interceptor and is never logged.
//
// Writes are whole-resource (Create/Update carry the full mutable record incl.
// every constraint sub-message), matching Ogen's contract — so List returns the
// full Platform too, letting the UI edit and reorder without a separate fetch.
package ogenplatforms

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"

	platformsv1 "github.com/ogen-app/harbor/gen/platforms/v1"
)

// ErrUnavailable is returned by every method on a nil (unconfigured) client.
// Callers treat it as "platform management unavailable", not a hard error —
// mirroring the ogensecrets/ogentenants nil-client contract.
var ErrUnavailable = errors.New("ogen platform-admin service not configured")

const defaultTimeout = 10 * time.Second

// Platform is the whole mutable record plus read-only usage/timestamps. Create/
// Update send it back verbatim (Ogen replaces the full resource), so the JSON
// shape the UI holds from List round-trips through an edit without losing any
// field. The constraint sub-messages are pointers: a nil block means "no limits
// of this kind configured".
type Platform struct {
	ID                 string            `json:"id"`
	Name               string            `json:"name"`
	ZernioID           string            `json:"zernioId"`
	Enabled            bool              `json:"enabled"`
	ConnectSupported   bool              `json:"connectSupported"`
	Cadence            string            `json:"cadence"`
	Constraints        string            `json:"constraints"`
	PostTypes          map[string]string `json:"postTypes"`
	SupportedPostTypes []string          `json:"supportedPostTypes"`
	SortOrder          int32             `json:"sortOrder"`
	ImageConstraints   *ImageConstraints `json:"imageConstraints"`
	VideoConstraints   *VideoConstraints `json:"videoConstraints"`
	PdfConstraints     *PdfConstraints   `json:"pdfConstraints"`
	TextConstraints    *TextConstraints  `json:"textConstraints"`
	Usage              PlatformUsage     `json:"usage"`
	CreatedAt          time.Time         `json:"createdAt"`
	UpdatedAt          time.Time         `json:"updatedAt"`
}

// PlatformUsage is the read-only footprint that drives the disable/delete
// guards: how many accounts are connected and how many posts are scheduled.
type PlatformUsage struct {
	ConnectedAccounts int32 `json:"connectedAccounts"`
	ScheduledPosts    int32 `json:"scheduledPosts"`
}

type ImageConstraints struct {
	MaxFileSizeBytes      int64    `json:"maxFileSizeBytes"`
	AllowedFormats        []string `json:"allowedFormats"`
	AnimatedGifSupported  bool     `json:"animatedGifSupported"`
	MaxAttachmentsPerPost int32    `json:"maxAttachmentsPerPost"`
}

type VideoConstraints struct {
	MaxFileSizeBytes      int64    `json:"maxFileSizeBytes"`
	AllowedFormats        []string `json:"allowedFormats"`
	MaxDurationSeconds    int32    `json:"maxDurationSeconds"`
	MinDurationSeconds    int32    `json:"minDurationSeconds"`
	MaxWidth              int32    `json:"maxWidth"`
	MaxHeight             int32    `json:"maxHeight"`
	AllowedAspectRatios   []string `json:"allowedAspectRatios"`
	MaxAttachmentsPerPost int32    `json:"maxAttachmentsPerPost"`
	RequiresVideoTitle    bool     `json:"requiresVideoTitle"`
}

type PdfConstraints struct {
	MaxFileSizeBytes      int64    `json:"maxFileSizeBytes"`
	AllowedFormats        []string `json:"allowedFormats"`
	MaxPages              int32    `json:"maxPages"`
	MaxAttachmentsPerPost int32    `json:"maxAttachmentsPerPost"`
}

type TextConstraints struct {
	MaxContentChars int32            `json:"maxContentChars"`
	MaxTitleChars   int32            `json:"maxTitleChars"`
	PerPostType     map[string]int32 `json:"perPostType"`
}

// GlobalLimits are the five cross-platform ceilings a per-platform limit can't
// exceed (Ogen enforces the relationship and returns InvalidArgument otherwise).
type GlobalLimits struct {
	MaxImageUploadBytes int64 `json:"maxImageUploadBytes"`
	MaxPdfUploadBytes   int64 `json:"maxPdfUploadBytes"`
	MaxVideoUploadBytes int64 `json:"maxVideoUploadBytes"`
	MaxAltTextChars     int32 `json:"maxAltTextChars"`
	MaxThreadSegments   int32 `json:"maxThreadSegments"`
}

// Client is a thin, safe wrapper over the generated PlatformAdminServiceClient.
type Client struct {
	conn    *grpc.ClientConn
	rpc     platformsv1.PlatformAdminServiceClient
	timeout time.Duration
}

// New dials Ogen's internal gRPC surface. Enabled only when BOTH addr and token
// are set (matching Ogen's server, which starts only when both are configured);
// either empty returns (nil, nil): a nil client that reports ErrUnavailable, so
// the page degrades softly rather than failing boot. grpc.NewClient connects
// lazily, so this never blocks on Ogen being up.
func New(addr, token string) (*Client, error) {
	if addr == "" || token == "" {
		return nil, nil
	}
	conn, err := grpc.NewClient(
		addr,
		// Plaintext transport by design: Ogen exposes its internal admin gRPC on
		// ONE shared, bearer-gated listener with no TLS (see the ogensecrets /
		// ogentenants clients, which dial the same way). The bearer token is the
		// auth boundary, so OGEN_GRPC_ADDR MUST resolve over a trusted private
		// link (Ogen and Harbor co-located / internal networking) and must never
		// traverse an untrusted hop. Enabling TLS here alone would break the
		// handshake with Ogen's plaintext listener; adopting TLS is a
		// cross-cutting change across Ogen's server and every Harbor client.
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithChainUnaryInterceptor(bearerTokenInterceptor(token)),
	)
	if err != nil {
		return nil, fmt.Errorf("ogenplatforms: dial %q: %w", addr, err)
	}
	return &Client{conn: conn, rpc: platformsv1.NewPlatformAdminServiceClient(conn), timeout: defaultTimeout}, nil
}

// Close releases the underlying connection. Safe on a nil client.
func (c *Client) Close() error {
	if c == nil || c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

// List returns the platform catalog. Operators manage the whole catalog, so
// includeDisabled=true surfaces disabled rows too (the seeded TikTok/Pinterest/
// Reddit and any freshly-added platform, which Ogen creates disabled) — without
// it they'd be invisible and could never be toggled on.
func (c *Client) List(ctx context.Context, includeDisabled bool) ([]Platform, error) {
	if c == nil {
		return nil, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.ListPlatforms(ctx, &platformsv1.ListPlatformsRequest{IncludeDisabled: includeDisabled})
	if err != nil {
		return nil, err
	}
	out := make([]Platform, 0, len(resp.GetPlatforms()))
	for _, p := range resp.GetPlatforms() {
		out = append(out, platformFromProto(p))
	}
	return out, nil
}

// Create adds a platform. Ogen mints the id and (per CON-292) creates it
// disabled; AlreadyExists comes back on a name/zernio_id clash.
func (c *Client) Create(ctx context.Context, p Platform) (Platform, error) {
	if c == nil {
		return Platform{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.CreatePlatform(ctx, &platformsv1.CreatePlatformRequest{Platform: platformToProto(p)})
	if err != nil {
		return Platform{}, err
	}
	return platformFromProto(resp.GetPlatform()), nil
}

// Update replaces the whole mutable record (id required). This is also how a
// sort_order change (drag-to-reorder) and an enabled change from the edit form
// are persisted, since Ogen has no partial update.
func (c *Client) Update(ctx context.Context, p Platform) (Platform, error) {
	if c == nil {
		return Platform{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.UpdatePlatform(ctx, &platformsv1.UpdatePlatformRequest{Platform: platformToProto(p)})
	if err != nil {
		return Platform{}, err
	}
	return platformFromProto(resp.GetPlatform()), nil
}

// SetEnabled soft-enables/disables a platform (existing scheduled posts keep
// running; new connects are blocked; it drops from the tenant composer).
func (c *Client) SetEnabled(ctx context.Context, id string, enabled bool) (Platform, error) {
	if c == nil {
		return Platform{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.SetPlatformEnabled(ctx, &platformsv1.SetPlatformEnabledRequest{Id: id, Enabled: enabled})
	if err != nil {
		return Platform{}, err
	}
	return platformFromProto(resp.GetPlatform()), nil
}

// Delete removes a platform. When it's still in use, Ogen returns
// FailedPrecondition unless force is set (which overrides the in-use guard).
func (c *Client) Delete(ctx context.Context, id string, force bool) error {
	if c == nil {
		return ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	_, err := c.rpc.DeletePlatform(ctx, &platformsv1.DeletePlatformRequest{Id: id, Force: force})
	return err
}

// GetGlobalLimits reads the five cross-platform ceilings.
func (c *Client) GetGlobalLimits(ctx context.Context) (GlobalLimits, error) {
	if c == nil {
		return GlobalLimits{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.GetGlobalLimits(ctx, &platformsv1.GetGlobalLimitsRequest{})
	if err != nil {
		return GlobalLimits{}, err
	}
	return globalLimitsFromProto(resp.GetLimits()), nil
}

// UpdateGlobalLimits writes the five cross-platform ceilings.
func (c *Client) UpdateGlobalLimits(ctx context.Context, l GlobalLimits) (GlobalLimits, error) {
	if c == nil {
		return GlobalLimits{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.UpdateGlobalLimits(ctx, &platformsv1.UpdateGlobalLimitsRequest{Limits: globalLimitsToProto(l)})
	if err != nil {
		return GlobalLimits{}, err
	}
	return globalLimitsFromProto(resp.GetLimits()), nil
}

// ── proto → DTO ────────────────────────────────────────────────────────────────

func platformFromProto(p *platformsv1.Platform) Platform {
	if p == nil {
		return Platform{}
	}
	return Platform{
		ID:                 p.GetId(),
		Name:               p.GetName(),
		ZernioID:           p.GetZernioId(),
		Enabled:            p.GetEnabled(),
		ConnectSupported:   p.GetConnectSupported(),
		Cadence:            p.GetCadence(),
		Constraints:        p.GetConstraints(),
		PostTypes:          p.GetPostTypes(),
		SupportedPostTypes: p.GetSupportedPostTypes(),
		SortOrder:          p.GetSortOrder(),
		ImageConstraints:   imageFromProto(p.GetImageConstraints()),
		VideoConstraints:   videoFromProto(p.GetVideoConstraints()),
		PdfConstraints:     pdfFromProto(p.GetPdfConstraints()),
		TextConstraints:    textFromProto(p.GetTextConstraints()),
		Usage: PlatformUsage{
			ConnectedAccounts: p.GetUsage().GetConnectedAccounts(),
			ScheduledPosts:    p.GetUsage().GetScheduledPosts(),
		},
		CreatedAt: p.GetCreatedAt().AsTime(),
		UpdatedAt: p.GetUpdatedAt().AsTime(),
	}
}

func imageFromProto(c *platformsv1.ImageConstraints) *ImageConstraints {
	if c == nil {
		return nil
	}
	return &ImageConstraints{
		MaxFileSizeBytes:      c.GetMaxFileSizeBytes(),
		AllowedFormats:        c.GetAllowedFormats(),
		AnimatedGifSupported:  c.GetAnimatedGifSupported(),
		MaxAttachmentsPerPost: c.GetMaxAttachmentsPerPost(),
	}
}

func videoFromProto(c *platformsv1.VideoConstraints) *VideoConstraints {
	if c == nil {
		return nil
	}
	return &VideoConstraints{
		MaxFileSizeBytes:      c.GetMaxFileSizeBytes(),
		AllowedFormats:        c.GetAllowedFormats(),
		MaxDurationSeconds:    c.GetMaxDurationSeconds(),
		MinDurationSeconds:    c.GetMinDurationSeconds(),
		MaxWidth:              c.GetMaxWidth(),
		MaxHeight:             c.GetMaxHeight(),
		AllowedAspectRatios:   c.GetAllowedAspectRatios(),
		MaxAttachmentsPerPost: c.GetMaxAttachmentsPerPost(),
		RequiresVideoTitle:    c.GetRequiresVideoTitle(),
	}
}

func pdfFromProto(c *platformsv1.PdfConstraints) *PdfConstraints {
	if c == nil {
		return nil
	}
	return &PdfConstraints{
		MaxFileSizeBytes:      c.GetMaxFileSizeBytes(),
		AllowedFormats:        c.GetAllowedFormats(),
		MaxPages:              c.GetMaxPages(),
		MaxAttachmentsPerPost: c.GetMaxAttachmentsPerPost(),
	}
}

func textFromProto(c *platformsv1.TextConstraints) *TextConstraints {
	if c == nil {
		return nil
	}
	return &TextConstraints{
		MaxContentChars: c.GetMaxContentChars(),
		MaxTitleChars:   c.GetMaxTitleChars(),
		PerPostType:     c.GetPerPostType(),
	}
}

func globalLimitsFromProto(l *platformsv1.GlobalLimits) GlobalLimits {
	if l == nil {
		return GlobalLimits{}
	}
	return GlobalLimits{
		MaxImageUploadBytes: l.GetMaxImageUploadBytes(),
		MaxPdfUploadBytes:   l.GetMaxPdfUploadBytes(),
		MaxVideoUploadBytes: l.GetMaxVideoUploadBytes(),
		MaxAltTextChars:     l.GetMaxAltTextChars(),
		MaxThreadSegments:   l.GetMaxThreadSegments(),
	}
}

// ── DTO → proto ────────────────────────────────────────────────────────────────
// Read-only fields (usage, timestamps) are intentionally omitted — the server
// owns them and ignores anything sent.

func platformToProto(p Platform) *platformsv1.Platform {
	return &platformsv1.Platform{
		Id:                 p.ID,
		Name:               p.Name,
		ZernioId:           p.ZernioID,
		Enabled:            p.Enabled,
		ConnectSupported:   p.ConnectSupported,
		Cadence:            p.Cadence,
		Constraints:        p.Constraints,
		PostTypes:          p.PostTypes,
		SupportedPostTypes: p.SupportedPostTypes,
		SortOrder:          p.SortOrder,
		ImageConstraints:   imageToProto(p.ImageConstraints),
		VideoConstraints:   videoToProto(p.VideoConstraints),
		PdfConstraints:     pdfToProto(p.PdfConstraints),
		TextConstraints:    textToProto(p.TextConstraints),
	}
}

func imageToProto(c *ImageConstraints) *platformsv1.ImageConstraints {
	if c == nil {
		return nil
	}
	return &platformsv1.ImageConstraints{
		MaxFileSizeBytes:      c.MaxFileSizeBytes,
		AllowedFormats:        c.AllowedFormats,
		AnimatedGifSupported:  c.AnimatedGifSupported,
		MaxAttachmentsPerPost: c.MaxAttachmentsPerPost,
	}
}

func videoToProto(c *VideoConstraints) *platformsv1.VideoConstraints {
	if c == nil {
		return nil
	}
	return &platformsv1.VideoConstraints{
		MaxFileSizeBytes:      c.MaxFileSizeBytes,
		AllowedFormats:        c.AllowedFormats,
		MaxDurationSeconds:    c.MaxDurationSeconds,
		MinDurationSeconds:    c.MinDurationSeconds,
		MaxWidth:              c.MaxWidth,
		MaxHeight:             c.MaxHeight,
		AllowedAspectRatios:   c.AllowedAspectRatios,
		MaxAttachmentsPerPost: c.MaxAttachmentsPerPost,
		RequiresVideoTitle:    c.RequiresVideoTitle,
	}
}

func pdfToProto(c *PdfConstraints) *platformsv1.PdfConstraints {
	if c == nil {
		return nil
	}
	return &platformsv1.PdfConstraints{
		MaxFileSizeBytes:      c.MaxFileSizeBytes,
		AllowedFormats:        c.AllowedFormats,
		MaxPages:              c.MaxPages,
		MaxAttachmentsPerPost: c.MaxAttachmentsPerPost,
	}
}

func textToProto(c *TextConstraints) *platformsv1.TextConstraints {
	if c == nil {
		return nil
	}
	return &platformsv1.TextConstraints{
		MaxContentChars: c.MaxContentChars,
		MaxTitleChars:   c.MaxTitleChars,
		PerPostType:     c.PerPostType,
	}
}

func globalLimitsToProto(l GlobalLimits) *platformsv1.GlobalLimits {
	return &platformsv1.GlobalLimits{
		MaxImageUploadBytes: l.MaxImageUploadBytes,
		MaxPdfUploadBytes:   l.MaxPdfUploadBytes,
		MaxVideoUploadBytes: l.MaxVideoUploadBytes,
		MaxAltTextChars:     l.MaxAltTextChars,
		MaxThreadSegments:   l.MaxThreadSegments,
	}
}

// bearerTokenInterceptor injects `authorization: Bearer <token>` into the
// outgoing metadata of every unary call. The token is never logged.
func bearerTokenInterceptor(token string) grpc.UnaryClientInterceptor {
	bearer := "Bearer " + token
	return func(ctx context.Context, method string, req, reply any, cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
		ctx = metadata.AppendToOutgoingContext(ctx, "authorization", bearer)
		return invoker(ctx, method, req, reply, cc, opts...)
	}
}
