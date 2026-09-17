// Shape of the /api/announcements surface. Mirrors the Go handler DTOs
// (ogenannouncements.Announcement + Stats + AnnouncementWithStats). Announcements
// are Ogen's tenant-facing informational banners (CON-230/300): authored here,
// targeted at all/groups/tiers, scheduled, published, and measured.
//
// Writes are whole-resource: Create/Update send the authored fields back (see
// AnnouncementInput). Status and publishedAt are moved by the status endpoint,
// never by an update. The optional window/publish timestamps are RFC3339 strings
// or null ("unset").

export type AnnouncementStatus = "draft" | "published" | "archived";

export interface Announcement {
  id: string;
  title: string;
  body: string;
  imageUrl: string;
  imageAlt: string;
  ctaLabel: string;
  ctaUrl: string;
  targetAll: boolean;
  targetGroupIds: string[] | null;
  targetTierIds: string[] | null;
  status: AnnouncementStatus;
  startsAt: string | null;
  endsAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Stats is the engagement rollup. clicked/dismissed are per unique user and per
// unique tenant; eligible* is the audience the targeting selects among active
// tenants (the rate denominator — impressions aren't tracked).
export interface Stats {
  uniqueUsersClicked: number;
  uniqueTenantsClicked: number;
  uniqueUsersDismissed: number;
  uniqueTenantsDismissed: number;
  eligibleTenants: number;
  eligibleUsers: number;
}

export interface AnnouncementWithStats {
  announcement: Announcement;
  stats: Stats;
}

export interface AnnouncementsListResponse {
  // false when Ogen's announcement-admin gRPC surface is unconfigured/unreachable
  // — the page renders a soft "unavailable" state rather than an error.
  available: boolean;
  items: AnnouncementWithStats[];
  // "" on the last page.
  nextPageToken: string;
}

// AnnouncementInput is the authored subset sent on create/update. Extra fields on
// the full Announcement (id/status/timestamps) are server-owned and ignored on
// write, so the form only sends these.
export interface AnnouncementInput {
  title: string;
  body: string;
  imageUrl: string;
  imageAlt: string;
  ctaLabel: string;
  ctaUrl: string;
  targetAll: boolean;
  targetGroupIds: string[];
  targetTierIds: string[];
  startsAt: string | null;
  endsAt: string | null;
}
