// Shape of GET /api/secrets. Mirrors the Go handler's listResponse +
// ogensecrets.SecretMeta. Names come from Ogen's authoritative allowlist — the
// UI never hardcodes them. Plaintext is never present; only metadata.
export interface SecretMeta {
  name: string;
  set: boolean;
  createdAt: string;
  updatedAt: string;
  kekVersion: number;
  algorithm: string;
  decryptable: boolean;
}

export interface SecretsListResponse {
  // false when Ogen's secrets gRPC surface is unconfigured/unreachable — the
  // tab renders a soft "unavailable" state rather than an error.
  available: boolean;
  secrets: SecretMeta[];
}
