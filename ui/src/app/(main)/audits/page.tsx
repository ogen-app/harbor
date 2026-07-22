import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import Image from "next/image";

export default function AuditsPage() {
    return (
        <main className="flex-1 overflow-auto flex flex-col">
            <header className="h-20 border-b border-border flex items-center justify-between px-6 shrink-0">
                <h1 className="text-2xl font-display font-medium">Audits</h1>
            </header>

            <div
                id="empty-state"
                className="flex-1 flex flex-col items-center justify-center gap-8"
            >
                <Image
                    src="/illustrations/folder-empty.webp"
                    alt="No audits"
                    width={250}
                    height={250}
                    className=""
                />
                <p className="text-sm text-tertiary-foreground">
                    No audits started yet
                </p>
                <Button size="lg">
                    <Icon name="plus" className="size-4" />
                    New Audit
                </Button>
            </div>
        </main>
    );
}
