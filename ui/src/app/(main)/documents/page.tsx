import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import Image from "next/image";

export default function DocumentsPage() {
    return (
        <main className="flex-1 overflow-auto flex flex-col">
            <header className="h-20 border-b border-border flex items-center justify-between px-6 shrink-0">
                <h1 className="text-2xl font-display font-medium">Documents</h1>
                {/*<Button size="lg">
                    <Icon name="plus" className="size-4" />
                    New Document
                </Button>*/}
            </header>

            <div
                id="empty-state"
                className="flex-1 flex flex-col items-center justify-center gap-8"
            >
                <Image
                    src="/illustrations/folder-empty.webp"
                    alt="No documents"
                    width={250}
                    height={250}
                    className=""
                />
                <p className="text-sm text-tertiary-foreground">
                    No documents created yet
                </p>
                <Button size="lg">
                    <Icon name="plus" className="size-4" />
                    New Document
                </Button>
            </div>
        </main>
    );
}
