import { TenantDetail } from "@/components/tenants/TenantDetail";

// The Tenants detail route is dynamic, but a static export needs at least one
// param up front and tenants are runtime data (unknown at build time). So we
// emit a single placeholder shell here; TenantDetail reads the real id from the
// URL at runtime, and the Go server serves this shell for every /tenants/<id>
// request (see src/server/static.go). Keep the sentinel in sync with that file.
export function generateStaticParams() {
  return [{ id: "_" }];
}

export default function TenantDetailPage() {
  return <TenantDetail />;
}
