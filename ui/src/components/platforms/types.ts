// Shape of the /api/platforms surface. Mirrors the Go handler DTOs
// (ogenplatforms.Platform + GlobalLimits). This is the social-platform catalog
// Ogen publishes to (CON-292/293); the list is fetched with
// include_disabled=true so disabled platforms are visible and can be toggled on.
//
// Writes are whole-resource: Create/Update send the full Platform back, so the
// object held from the list round-trips through an edit (and a reorder) without
// losing a field. Constraint blocks are nullable — null means "no limits of
// this kind configured".
export interface PlatformUsage {
  connectedAccounts: number;
  scheduledPosts: number;
}

export interface ImageConstraints {
  maxFileSizeBytes: number;
  allowedFormats: string[] | null;
  animatedGifSupported: boolean;
  maxAttachmentsPerPost: number;
}

export interface VideoConstraints {
  maxFileSizeBytes: number;
  allowedFormats: string[] | null;
  maxDurationSeconds: number;
  minDurationSeconds: number;
  maxWidth: number;
  maxHeight: number;
  allowedAspectRatios: string[] | null;
  maxAttachmentsPerPost: number;
  requiresVideoTitle: boolean;
}

export interface PdfConstraints {
  maxFileSizeBytes: number;
  allowedFormats: string[] | null;
  maxPages: number;
  maxAttachmentsPerPost: number;
}

export interface TextConstraints {
  maxContentChars: number;
  maxTitleChars: number;
  // slug -> char override. null/absent when no per-post-type overrides exist.
  perPostType: Record<string, number> | null;
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
  imageConstraints: ImageConstraints | null;
  videoConstraints: VideoConstraints | null;
  pdfConstraints: PdfConstraints | null;
  textConstraints: TextConstraints | null;
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

// The five cross-platform ceilings a per-platform limit can't exceed.
export interface GlobalLimits {
  maxImageUploadBytes: number;
  maxPdfUploadBytes: number;
  maxVideoUploadBytes: number;
  maxAltTextChars: number;
  maxThreadSegments: number;
}

export interface GlobalLimitsResponse {
  available: boolean;
  limits: GlobalLimits;
}
