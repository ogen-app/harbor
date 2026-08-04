import { Suspense } from "react";
import { EmailTemplatesEditor } from "@/components/email-templates/EmailTemplatesEditor";

export default function EmailTemplatesPage() {
  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      {/* The editor owns the header (title + New template) and the two-panel
          card body. It reads the selected template key from the URL query
          (?template=…) via useSearchParams, which a static export requires be
          wrapped in a Suspense boundary. */}
      <Suspense fallback={<div className="flex-1" />}>
        <EmailTemplatesEditor />
      </Suspense>
    </main>
  );
}
