import { DatabaseStatus } from "@/components/dashboard/DatabaseStatus";

export default function DatabasesPage() {
    return (
        <main className="flex-1 overflow-auto flex flex-col">
            <header className="h-20 border-b border-border flex items-center justify-between px-6 shrink-0">
                <h1 className="text-2xl font-display font-medium">Databases</h1>
            </header>
            <div className="dashboard-numeric p-6 space-y-6">
                <DatabaseStatus />
            </div>
        </main>
    );
}
