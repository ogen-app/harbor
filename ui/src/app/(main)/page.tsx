import { DatabaseStatus } from "@/components/dashboard/DatabaseStatus";
import { TenantsSection } from "@/components/dashboard/TenantsSection";
import { GreetingMessage } from "@/components/dashboard/GreetingMessage";

export default function DashboardPage() {
    return (
        <main className="flex-1 overflow-auto flex flex-col">
            <header className="h-20 border-b border-border flex items-center justify-between px-6 shrink-0">
                <h1 className="text-2xl font-display">
                    <GreetingMessage />
                </h1>
            </header>
            <div className="dashboard-numeric p-6 space-y-6">
                <TenantsSection />
                <DatabaseStatus />
            </div>
        </main>
    );
}
