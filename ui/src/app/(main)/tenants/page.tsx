import { TenantsTable } from "@/components/tenants/TenantsTable";

export default function TenantsPage() {
    return (
        <main className="flex-1 overflow-auto flex flex-col">
            <header className="h-20 border-b border-border flex items-center justify-between px-6 shrink-0">
                <h1 className="text-2xl font-display font-medium">Tenants</h1>
            </header>
            <div className="p-6">
                <TenantsTable />
            </div>
        </main>
    );
}
