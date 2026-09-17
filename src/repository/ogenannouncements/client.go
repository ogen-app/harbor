// Package ogenannouncements is Harbor's gRPC client for Ogen's internal
// AnnouncementAdminService — the operator surface for authoring, targeting,
// scheduling and measuring tenant announcements (CON-230/300).
//
// Like ogenplatforms/ogentenants (whose listener and shared bearer token this
// reuses), the client is best-effort: an unconfigured (empty addr/token) client
// is nil and every method returns ErrUnavailable, which the handler renders as
// a soft "unavailable" state. The bearer token is injected into outgoing gRPC
// metadata by a client interceptor and is never logged.
//
// Writes are whole-resource (Create/Update carry the full authored record incl.
// the targeting sets), matching Ogen's contract — so List/Get return the full
// Announcement too, letting the UI edit without a separate fetch. Status and
// published_at are moved by SetStatus, never by Update.
package ogenannouncements

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/timestamppb"

	announcementsv1 "github.com/ogen-app/harbor/gen/announcements/v1"
)

// ErrUnavailable is returned by every method on a nil (unconfigured) client.
// Callers treat it as "announcement management unavailable", not a hard error —
// mirroring the ogenplatforms/ogentenants nil-client contract.
var ErrUnavailable = errors.New("ogen announcement-admin service not configured")

const defaultTimeout = 10 * time.Second

// Announcement is the whole authored record plus the server-owned lifecycle
// fields. Create/Update send the authored subset back (see inputToProto), so the
// JSON shape the UI holds from List/Get round-trips through an edit. The optional
// window/publish timestamps are pointers: a nil value means "unset" (live once
// published / no expiry / not yet published).
type Announcement struct {
	ID             string     `json:"id"`
	Title          string     `json:"title"`
	Body           string     `json:"body"`
	ImageURL       string     `json:"imageUrl"`  // absolute https url ('' = no image)
	ImageAlt       string     `json:"imageAlt"`  // accessibility alt text
	CtaLabel       string     `json:"ctaLabel"`  // '' = no CTA (info/dismiss only)
	CtaURL         string     `json:"ctaUrl"`    // required iff ctaLabel is set
	TargetAll      bool       `json:"targetAll"` // reaches every active tenant
	TargetGroupIDs []string   `json:"targetGroupIds"`
	TargetTierIDs  []string   `json:"targetTierIds"`
	Status         string     `json:"status"`      // draft | published | archived
	StartsAt       *time.Time `json:"startsAt"`    // nil = live once published
	EndsAt         *time.Time `json:"endsAt"`      // nil = no expiry
	PublishedAt    *time.Time `json:"publishedAt"` // nil until first publish
	CreatedAt      time.Time  `json:"createdAt"`
	UpdatedAt      time.Time  `json:"updatedAt"`
}

// Stats is the engagement rollup for one announcement. clicked/dismissed are
// counted per unique user and per unique tenant; eligible_* is the audience the
// targeting selects among active tenants (the rate denominator, since
// impressions are not tracked).
type Stats struct {
	UniqueUsersClicked     int32 `json:"uniqueUsersClicked"`
	UniqueTenantsClicked   int32 `json:"uniqueTenantsClicked"`
	UniqueUsersDismissed   int32 `json:"uniqueUsersDismissed"`
	UniqueTenantsDismissed int32 `json:"uniqueTenantsDismissed"`
	EligibleTenants        int32 `json:"eligibleTenants"`
	EligibleUsers          int32 `json:"eligibleUsers"`
}

// AnnouncementWithStats pairs a record with its engagement rollup — the unit
// both List and Get return.
type AnnouncementWithStats struct {
	Announcement Announcement `json:"announcement"`
	Stats        Stats        `json:"stats"`
}

// ListResult is one keyset page of history. NextPageToken is "" on the last page.
type ListResult struct {
	Items         []AnnouncementWithStats `json:"items"`
	NextPageToken string                  `json:"nextPageToken"`
}

// Client is a thin, safe wrapper over the generated AnnouncementAdminServiceClient.
type Client struct {
	conn    *grpc.ClientConn
	rpc     announcementsv1.AnnouncementAdminServiceClient
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
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithChainUnaryInterceptor(bearerTokenInterceptor(token)),
	)
	if err != nil {
		return nil, fmt.Errorf("ogenannouncements: dial %q: %w", addr, err)
	}
	return &Client{conn: conn, rpc: announcementsv1.NewAnnouncementAdminServiceClient(conn), timeout: defaultTimeout}, nil
}

// Close releases the underlying connection. Safe on a nil client.
func (c *Client) Close() error {
	if c == nil || c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

// List returns one page of announcement history, newest first. status is an
// optional filter (draft | published | archived; "" = any); pageToken is the
// opaque keyset cursor from a prior response ("" for the first page). pageSize is
// clamped server-side (0 = server default).
func (c *Client) List(ctx context.Context, status string, pageSize int32, pageToken string) (ListResult, error) {
	if c == nil {
		return ListResult{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.ListAnnouncements(ctx, &announcementsv1.ListAnnouncementsRequest{
		PageSize:  pageSize,
		PageToken: pageToken,
		Status:    status,
	})
	if err != nil {
		return ListResult{}, err
	}
	items := make([]AnnouncementWithStats, 0, len(resp.GetItems()))
	for _, it := range resp.GetItems() {
		items = append(items, withStatsFromProto(it))
	}
	return ListResult{Items: items, NextPageToken: resp.GetNextPageToken()}, nil
}

// Get returns one announcement with its targeting and stats. NotFound comes back
// for an unknown id.
func (c *Client) Get(ctx context.Context, id string) (AnnouncementWithStats, error) {
	if c == nil {
		return AnnouncementWithStats{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.GetAnnouncement(ctx, &announcementsv1.GetAnnouncementRequest{Id: id})
	if err != nil {
		return AnnouncementWithStats{}, err
	}
	return withStatsFromProto(resp.GetItem()), nil
}

// Create adds an announcement. Ogen mints the id and creates it in the draft
// status; InvalidArgument comes back on a bad payload (e.g. CTA label without url,
// non-all targeting with empty sets is a warn on the UI but Ogen validates too).
func (c *Client) Create(ctx context.Context, a Announcement) (Announcement, error) {
	if c == nil {
		return Announcement{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.CreateAnnouncement(ctx, &announcementsv1.CreateAnnouncementRequest{
		Announcement: inputToProto(a),
	})
	if err != nil {
		return Announcement{}, err
	}
	return announcementFromProto(resp.GetAnnouncement()), nil
}

// Update replaces the authored fields and targeting sets (id required). Status
// and published_at are not touched here — use SetStatus. NotFound for an unknown
// id; InvalidArgument on a bad payload.
func (c *Client) Update(ctx context.Context, a Announcement) (Announcement, error) {
	if c == nil {
		return Announcement{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.UpdateAnnouncement(ctx, &announcementsv1.UpdateAnnouncementRequest{
		Id:           a.ID,
		Announcement: inputToProto(a),
	})
	if err != nil {
		return Announcement{}, err
	}
	return announcementFromProto(resp.GetAnnouncement()), nil
}

// SetStatus transitions the lifecycle: draft -> published (stamps published_at on
// the first publish and starts delivery) or -> archived (retires it from delivery
// while keeping its stats). FailedPrecondition on an illegal transition.
func (c *Client) SetStatus(ctx context.Context, id, status string) (Announcement, error) {
	if c == nil {
		return Announcement{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.SetAnnouncementStatus(ctx, &announcementsv1.SetAnnouncementStatusRequest{
		Id:     id,
		Status: status,
	})
	if err != nil {
		return Announcement{}, err
	}
	return announcementFromProto(resp.GetAnnouncement()), nil
}

// Delete hard-deletes a draft announcement. A published or archived one is
// retained for history: Ogen returns FailedPrecondition (archive it instead).
func (c *Client) Delete(ctx context.Context, id string) error {
	if c == nil {
		return ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	_, err := c.rpc.DeleteAnnouncement(ctx, &announcementsv1.DeleteAnnouncementRequest{Id: id})
	return err
}

// ── proto → DTO ────────────────────────────────────────────────────────────────

func withStatsFromProto(w *announcementsv1.AnnouncementWithStats) AnnouncementWithStats {
	if w == nil {
		return AnnouncementWithStats{}
	}
	return AnnouncementWithStats{
		Announcement: announcementFromProto(w.GetAnnouncement()),
		Stats:        statsFromProto(w.GetStats()),
	}
}

func announcementFromProto(a *announcementsv1.Announcement) Announcement {
	if a == nil {
		return Announcement{}
	}
	return Announcement{
		ID:             a.GetId(),
		Title:          a.GetTitle(),
		Body:           a.GetBody(),
		ImageURL:       a.GetImageUrl(),
		ImageAlt:       a.GetImageAlt(),
		CtaLabel:       a.GetCtaLabel(),
		CtaURL:         a.GetCtaUrl(),
		TargetAll:      a.GetTargetAll(),
		TargetGroupIDs: a.GetTargetGroupIds(),
		TargetTierIDs:  a.GetTargetTierIds(),
		Status:         a.GetStatus(),
		StartsAt:       timePtr(a.GetStartsAt()),
		EndsAt:         timePtr(a.GetEndsAt()),
		PublishedAt:    timePtr(a.GetPublishedAt()),
		CreatedAt:      a.GetCreatedAt().AsTime(),
		UpdatedAt:      a.GetUpdatedAt().AsTime(),
	}
}

func statsFromProto(s *announcementsv1.AnnouncementStats) Stats {
	if s == nil {
		return Stats{}
	}
	return Stats{
		UniqueUsersClicked:     s.GetUniqueUsersClicked(),
		UniqueTenantsClicked:   s.GetUniqueTenantsClicked(),
		UniqueUsersDismissed:   s.GetUniqueUsersDismissed(),
		UniqueTenantsDismissed: s.GetUniqueTenantsDismissed(),
		EligibleTenants:        s.GetEligibleTenants(),
		EligibleUsers:          s.GetEligibleUsers(),
	}
}

// ── DTO → proto ────────────────────────────────────────────────────────────────
// Only the authored fields are sent — the server owns id/status/published_at and
// the timestamps, and ignores anything sent for them.

func inputToProto(a Announcement) *announcementsv1.AnnouncementInput {
	return &announcementsv1.AnnouncementInput{
		Title:          a.Title,
		Body:           a.Body,
		ImageUrl:       a.ImageURL,
		ImageAlt:       a.ImageAlt,
		CtaLabel:       a.CtaLabel,
		CtaUrl:         a.CtaURL,
		TargetAll:      a.TargetAll,
		TargetGroupIds: a.TargetGroupIDs,
		TargetTierIds:  a.TargetTierIDs,
		StartsAt:       tsPtr(a.StartsAt),
		EndsAt:         tsPtr(a.EndsAt),
	}
}

// timePtr converts an optional proto timestamp to *time.Time — nil (and the zero
// timestamp Ogen sends for an unset field) both map to nil, so the UI can tell
// "unset" from a real instant.
func timePtr(ts *timestamppb.Timestamp) *time.Time {
	if ts == nil || (ts.GetSeconds() == 0 && ts.GetNanos() == 0) {
		return nil
	}
	t := ts.AsTime()
	return &t
}

// tsPtr converts an optional *time.Time to a proto timestamp — nil maps to nil
// (Ogen reads that as "unset").
func tsPtr(t *time.Time) *timestamppb.Timestamp {
	if t == nil {
		return nil
	}
	return timestamppb.New(*t)
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
