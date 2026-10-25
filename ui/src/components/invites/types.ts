// Shapes of Harbor's /api/invites + /api/signup-settings REST surface (CON-334) —
// a thin adapter over Ogen's tenantinvites.v1.TenantInviteAdminService (CON-333).
// Mirrors src/repository/ogeninvites. Optional instants are null when unset.

export type InviteStatus = "pending" | "expired" | "redeemed" | "revoked";

export interface InviteGroup {
  id: string;
  name: string;
  color: string; // '' when unset
}

export interface Invite {
  id: string;
  email: string;
  tierId: string; // '' once the tier was deleted
  tierName: string;
  tierPurchasable: boolean; // false for a hidden tier (not sold)
  groups: InviteGroup[];
  message: string; // shown in the email
  note: string; // operator-only
  createdBy: string;
  status: InviteStatus; // derived by Ogen (expired = pending past expiresAt)
  expiresAt: string | null;
  sentCount: number;
  lastSentAt: string | null;
  // The latest send's last delivery event (delivered, opened, bounced, …) or,
  // without one, the send outcome (sent, skipped_suppressed, failed, …); ''
  // until the email worker ran.
  emailStatus: string;
  emailLastEventAt: string | null;
  redeemedAt: string | null;
  redeemedTenantId: string;
  redeemedTenantName: string;
  // The workspace is still complimentary (false once beta access was ended).
  redeemedTenantComplimentary: boolean;
  revokedAt: string | null;
  createdAt: string | null;
}

export interface InvitesListResponse {
  available: boolean;
  invites: Invite[];
  nextPageToken: string;
}

export interface InviteResponse {
  invite: Invite;
  replaced: boolean; // create only: a pending invite for the address was replaced
}

export interface InviteInput {
  email: string;
  tierId: string;
  groupIds: string[];
  expiresInHours: number;
  message: string;
  note: string;
}

export type SignupMode = "open" | "invite_only";

export interface SignupSettings {
  mode: SignupMode;
  // While invite_only, how many live workspaces an account may own (0 = no cap).
  maxOwnedWorkspaces: number;
  updatedAt: string | null;
  updatedBy: string;
}

export interface SignupSettingsResponse {
  available: boolean;
  settings: SignupSettings;
}

// A failed write's body: Fiber's {error}, plus a machine-readable code for the
// FailedPrecondition sub-reasons the UI has guidance for.
export interface InviteErrorBody {
  error?: string;
  code?: "account_exists" | "tier_not_active" | string;
}
