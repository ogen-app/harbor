import { Suspense } from "react";
import { EmailTemplatesEditor } from "@/components/email-templates/EmailTemplatesEditor";

export default function EmailTemplatesPage() {
  return (
    <main className="flex-1 flex flex-col overflow-hidden">
      <header className="h-20 border-b border-border flex items-center px-6 shrink-0">
        <h1 className="text-2xl font-display font-medium">Email templates</h1>
      </header>

      {/* Padded wrapper puts the content in a white card (bg-primary), matching
          the /databases page. The editor reads the selected template key from
          the URL query (?template=…) via useSearchParams, which a static export
          requires be wrapped in a Suspense boundary. */}
      <div className="flex min-h-0 flex-1 flex-col p-6">
        <Suspense fallback={<div className="flex-1" />}>
          <EmailTemplatesEditor />
        </Suspense>
      </div>
    </main>
  );
}
