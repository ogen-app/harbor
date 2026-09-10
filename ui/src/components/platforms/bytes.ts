// Byte helpers for the constraint editors. Ogen stores media size caps in raw
// bytes; operators think in MB/GB. These convert between the two for the
// ByteField input (which edits in MB) and the human-readable hints under it.

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

// bytesToMB converts a raw byte count to megabytes for display in an input.
// Non-finite / negative values collapse to 0.
export function bytesToMB(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return bytes / MB;
}

// mbToBytes converts a (possibly fractional) MB value back to whole bytes,
// rounding to the nearest byte. Non-finite / negative collapses to 0.
export function mbToBytes(mb: number): number {
  if (!Number.isFinite(mb) || mb <= 0) return 0;
  return Math.round(mb * MB);
}

// formatBytes renders a raw byte count as a compact human string (e.g. "5 MB",
// "1.5 GB"), used for the read-only hints beside byte fields.
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= GB) {
    const v = bytes / GB;
    return `${v >= 100 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} GB`;
  }
  const v = bytes / MB;
  return `${v >= 100 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} MB`;
}
