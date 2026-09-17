package ogenannouncements

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/timestamppb"

	announcementsv1 "github.com/ogen-app/harbor/gen/announcements/v1"
)

// fakeServer stands in for Ogen's AnnouncementAdminService. It records the bearer
// token it received (so the test can assert the auth interceptor fires) and the
// key request fields it was called with, and echoes canned data so the client's
// proto↔struct mapping is exercised end-to-end in both directions.
type fakeServer struct {
	announcementsv1.UnimplementedAnnouncementAdminServiceServer
	gotAuth      string
	lastListReq  *announcementsv1.ListAnnouncementsRequest
	lastGetID    string
	lastCreate   *announcementsv1.AnnouncementInput
	lastUpdateID string
	lastUpdate   *announcementsv1.AnnouncementInput
	lastStatusID string
	lastStatus   string
	lastDeleteID string
}

func (s *fakeServer) auth(ctx context.Context) {
	if md, ok := metadata.FromIncomingContext(ctx); ok {
		if v := md.Get("authorization"); len(v) > 0 {
			s.gotAuth = v[0]
		}
	}
}

func (s *fakeServer) ListAnnouncements(ctx context.Context, req *announcementsv1.ListAnnouncementsRequest) (*announcementsv1.ListAnnouncementsResponse, error) {
	s.auth(ctx)
	s.lastListReq = req
	return &announcementsv1.ListAnnouncementsResponse{
		Items: []*announcementsv1.AnnouncementWithStats{
			{
				Announcement: &announcementsv1.Announcement{
					Id:             "a1",
					Title:          "Scheduled maintenance",
					Body:           "We'll be down Sunday.",
					ImageUrl:       "https://cdn.example.com/x.png",
					ImageAlt:       "banner",
					CtaLabel:       "Learn more",
					CtaUrl:         "https://example.com/status",
					TargetAll:      false,
					TargetGroupIds: []string{"g1"},
					TargetTierIds:  []string{"t1", "t2"},
					Status:         "published",
					StartsAt:       timestamppb.New(time.Unix(2000, 0)),
					PublishedAt:    timestamppb.New(time.Unix(2500, 0)),
					CreatedAt:      timestamppb.New(time.Unix(1000, 0)),
					UpdatedAt:      timestamppb.New(time.Unix(3000, 0)),
				},
				Stats: &announcementsv1.AnnouncementStats{
					UniqueUsersClicked:   12,
					UniqueTenantsClicked: 5,
					UniqueUsersDismissed: 3,
					EligibleTenants:      40,
					EligibleUsers:        220,
				},
			},
			{Announcement: &announcementsv1.Announcement{Id: "a2", Title: "Draft", Status: "draft"}},
		},
		NextPageToken: "next-cursor",
	}, nil
}

func (s *fakeServer) GetAnnouncement(ctx context.Context, req *announcementsv1.GetAnnouncementRequest) (*announcementsv1.GetAnnouncementResponse, error) {
	s.auth(ctx)
	s.lastGetID = req.GetId()
	return &announcementsv1.GetAnnouncementResponse{Item: &announcementsv1.AnnouncementWithStats{
		Announcement: &announcementsv1.Announcement{Id: req.GetId(), Title: "Detail", Status: "archived"},
		Stats:        &announcementsv1.AnnouncementStats{UniqueUsersClicked: 99, EligibleUsers: 100},
	}}, nil
}

func (s *fakeServer) CreateAnnouncement(ctx context.Context, req *announcementsv1.CreateAnnouncementRequest) (*announcementsv1.CreateAnnouncementResponse, error) {
	s.auth(ctx)
	s.lastCreate = req.GetAnnouncement()
	return &announcementsv1.CreateAnnouncementResponse{Announcement: &announcementsv1.Announcement{
		Id:     "new-id",
		Title:  req.GetAnnouncement().GetTitle(),
		Status: "draft",
	}}, nil
}

func (s *fakeServer) UpdateAnnouncement(ctx context.Context, req *announcementsv1.UpdateAnnouncementRequest) (*announcementsv1.UpdateAnnouncementResponse, error) {
	s.auth(ctx)
	s.lastUpdateID = req.GetId()
	s.lastUpdate = req.GetAnnouncement()
	return &announcementsv1.UpdateAnnouncementResponse{Announcement: &announcementsv1.Announcement{Id: req.GetId(), Title: req.GetAnnouncement().GetTitle()}}, nil
}

func (s *fakeServer) SetAnnouncementStatus(ctx context.Context, req *announcementsv1.SetAnnouncementStatusRequest) (*announcementsv1.SetAnnouncementStatusResponse, error) {
	s.auth(ctx)
	s.lastStatusID = req.GetId()
	s.lastStatus = req.GetStatus()
	return &announcementsv1.SetAnnouncementStatusResponse{Announcement: &announcementsv1.Announcement{Id: req.GetId(), Status: req.GetStatus()}}, nil
}

func (s *fakeServer) DeleteAnnouncement(ctx context.Context, req *announcementsv1.DeleteAnnouncementRequest) (*announcementsv1.DeleteAnnouncementResponse, error) {
	s.auth(ctx)
	s.lastDeleteID = req.GetId()
	return &announcementsv1.DeleteAnnouncementResponse{}, nil
}

// startServer boots the fake on a real loopback listener and returns its addr.
func startServer(t *testing.T, srv announcementsv1.AnnouncementAdminServiceServer) string {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	gs := grpc.NewServer()
	announcementsv1.RegisterAnnouncementAdminServiceServer(gs, srv)
	go func() { _ = gs.Serve(lis) }()
	t.Cleanup(gs.Stop)
	return lis.Addr().String()
}

func newClient(t *testing.T, fake *fakeServer) *Client {
	t.Helper()
	addr := startServer(t, fake)
	client, err := New(addr, "tok-123")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if client == nil {
		t.Fatal("client is nil with addr+token set")
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

// TestClientListRoundTrip drives Harbor's real client against a live server: it
// proves the dial, the bearer-token interceptor, the status filter + pagination
// request fields, and the proto→Announcement/Stats mapping (incl. targeting sets
// and the optional-timestamp handling) all work over the wire — the exact path
// /api/announcements uses.
func TestClientListRoundTrip(t *testing.T) {
	fake := &fakeServer{}
	client := newClient(t, fake)

	res, err := client.List(t.Context(), "published", 25, "cursor-in")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if fake.lastListReq.GetStatus() != "published" || fake.lastListReq.GetPageSize() != 25 || fake.lastListReq.GetPageToken() != "cursor-in" {
		t.Errorf("list req wrong: %+v", fake.lastListReq)
	}
	if res.NextPageToken != "next-cursor" {
		t.Errorf("next page token = %q, want next-cursor", res.NextPageToken)
	}
	if len(res.Items) != 2 {
		t.Fatalf("List returned %d items, want 2", len(res.Items))
	}
	a := res.Items[0].Announcement
	if a.Title != "Scheduled maintenance" || a.CtaLabel != "Learn more" || a.CtaURL != "https://example.com/status" {
		t.Errorf("mapped announcement wrong: %+v", a)
	}
	if len(a.TargetGroupIDs) != 1 || len(a.TargetTierIDs) != 2 || a.TargetAll {
		t.Errorf("mapped targeting wrong: %+v", a)
	}
	if a.StartsAt == nil || a.PublishedAt == nil {
		t.Errorf("expected set timestamps to map non-nil: %+v", a)
	}
	if a.EndsAt != nil {
		t.Errorf("unset ends_at should map to nil, got %v", a.EndsAt)
	}
	st := res.Items[0].Stats
	if st.UniqueUsersClicked != 12 || st.UniqueTenantsClicked != 5 || st.EligibleUsers != 220 {
		t.Errorf("mapped stats wrong: %+v", st)
	}
	if fake.gotAuth != "Bearer tok-123" {
		t.Errorf("server saw authorization %q, want %q", fake.gotAuth, "Bearer tok-123")
	}
}

// TestClientGet proves Get carries the id and maps the with-stats item.
func TestClientGet(t *testing.T) {
	fake := &fakeServer{}
	client := newClient(t, fake)

	got, err := client.Get(t.Context(), "a7")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if fake.lastGetID != "a7" {
		t.Errorf("Get req id = %q, want a7", fake.lastGetID)
	}
	if got.Announcement.Status != "archived" || got.Stats.UniqueUsersClicked != 99 {
		t.Errorf("Get mapped wrong: %+v", got)
	}
}

// TestClientWrites proves the DTO→proto direction for every write: the authored
// fields (incl. targeting + schedule) reach the server on create/update, and the
// status/delete requests carry their fields.
func TestClientWrites(t *testing.T) {
	fake := &fakeServer{}
	client := newClient(t, fake)
	ctx := t.Context()

	starts := time.Unix(5000, 0)
	in := Announcement{
		Title:          "New feature",
		Body:           "Try it now.",
		CtaLabel:       "Open",
		CtaURL:         "https://example.com/feature",
		TargetAll:      false,
		TargetGroupIDs: []string{"g1", "g2"},
		TargetTierIDs:  []string{"t9"},
		StartsAt:       &starts,
	}
	created, err := client.Create(ctx, in)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if created.ID != "new-id" {
		t.Errorf("created id = %q, want server-minted new-id", created.ID)
	}
	if fake.lastCreate.GetTitle() != "New feature" || fake.lastCreate.GetCtaUrl() != "https://example.com/feature" {
		t.Errorf("create didn't carry authored fields: %+v", fake.lastCreate)
	}
	if len(fake.lastCreate.GetTargetGroupIds()) != 2 || len(fake.lastCreate.GetTargetTierIds()) != 1 {
		t.Errorf("create didn't carry targeting: %+v", fake.lastCreate)
	}
	if fake.lastCreate.GetStartsAt() == nil {
		t.Errorf("create didn't carry starts_at")
	}

	if _, err := client.Update(ctx, Announcement{ID: "a1", Title: "Edited"}); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if fake.lastUpdateID != "a1" || fake.lastUpdate.GetTitle() != "Edited" {
		t.Errorf("update req wrong: id=%q %+v", fake.lastUpdateID, fake.lastUpdate)
	}

	if _, err := client.SetStatus(ctx, "a1", "archived"); err != nil {
		t.Fatalf("SetStatus: %v", err)
	}
	if fake.lastStatusID != "a1" || fake.lastStatus != "archived" {
		t.Errorf("SetStatus req wrong: id=%q status=%q", fake.lastStatusID, fake.lastStatus)
	}

	if err := client.Delete(ctx, "a2"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if fake.lastDeleteID != "a2" {
		t.Errorf("Delete req id = %q, want a2", fake.lastDeleteID)
	}
}

// TestNewDisabled verifies the fail-open contract: a missing addr or token yields
// a nil client whose methods report ErrUnavailable (never a panic).
func TestNewDisabled(t *testing.T) {
	for _, tc := range []struct{ addr, token string }{
		{"", ""},
		{"", "tok"},
		{"localhost:9091", ""},
	} {
		c, err := New(tc.addr, tc.token)
		if err != nil {
			t.Fatalf("New(%q,%q): unexpected error %v", tc.addr, tc.token, err)
		}
		if c != nil {
			t.Errorf("New(%q,%q) = non-nil, want nil (disabled)", tc.addr, tc.token)
		}
		if _, err := c.List(t.Context(), "", 0, ""); !errors.Is(err, ErrUnavailable) {
			t.Errorf("nil client List err = %v, want ErrUnavailable", err)
		}
		if _, err := c.Create(t.Context(), Announcement{}); !errors.Is(err, ErrUnavailable) {
			t.Errorf("nil client Create err = %v, want ErrUnavailable", err)
		}
		if err := c.Delete(t.Context(), "x"); !errors.Is(err, ErrUnavailable) {
			t.Errorf("nil client Delete err = %v, want ErrUnavailable", err)
		}
	}
}
