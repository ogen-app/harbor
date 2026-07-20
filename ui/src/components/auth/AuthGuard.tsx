"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "./AuthProvider";

// AuthGuard gates the authenticated app shell. While the current user is being
// resolved it shows a spinner; anonymous visitors are redirected to /login.
// This is UX only — the real protection is that every data API requires the
// session cookie.
export function AuthGuard({ children }: { children: React.ReactNode }) {
    const { user, loading } = useAuth();
    const router = useRouter();

    useEffect(() => {
        if (!loading && !user) {
            router.replace("/login");
        }
    }, [loading, user, router]);

    if (loading || !user) {
        return (
            <div className="flex h-screen w-full items-center justify-center bg-background">
                <Spinner />
            </div>
        );
    }

    return <>{children}</>;
}
