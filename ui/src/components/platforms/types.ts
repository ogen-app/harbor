// Shape of GET /api/platforms. Mirrors the Go handler's platformsListResponse +
// ogenplatforms.Platform. This is the social-platform catalog Ogen publishes to
// (CON-292/293); the list is fetched with include_disabled=true so disabled
// platforms are visible and can be toggled on. The per-media constraint editors
// (image/video/pdf/text) and the global-limits panel arrive in later iterations,
// so those fields aren't carried yet.
export interface PlatformUsage {
  connectedAccounts: number;
  scheduledPosts: number;
}

export interface Platform {
  id: string;
  name: string;
  // Zernio wire slug (e.g. "twitter", "linkedin"); also keys the brand icon.
  zernioId: string;
  enabled: boolean;
  connectSupported: boolean;
  cadence: string;
  constraints: string;
  // slug -> display label. May be null/absent when a platform has none yet.
  postTypes: Record<string, string> | null;
  // Zernio-publishable subset of the post-type slugs.
  supportedPostTypes: string[] | null;
  sortOrder: number;
  usage: PlatformUsage;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformsListResponse {
  // false when Ogen's platform-admin gRPC surface is unconfigured/unreachable —
  // the page renders a soft "unavailable" state rather than an error.
  available: boolean;
  platforms: Platform[];
}
