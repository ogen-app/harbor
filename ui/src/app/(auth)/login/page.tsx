"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import loginBg from "@/assets/illustrations/login-bg.jpg";
import { getMe, loginWithGoogle } from "@/lib/auth";

export default function LoginPage() {
    const router = useRouter();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Already signed in? Skip the login screen.
    useEffect(() => {
        void getMe()
            .then((user) => {
                if (user) router.replace("/");
            })
            .catch(() => {});
    }, [router]);

    const handleLogin = async () => {
        setError(null);
        setLoading(true);
        try {
            await loginWithGoogle();
            router.replace("/");
        } catch (e) {
            setError(e instanceof Error ? e.message : "Login failed.");
            setLoading(false);
        }
    };

    return (
        <div className="relative min-h-screen flex items-center justify-center overflow-hidden">
            {/* Full-page background image */}
            <Image
                src={loginBg}
                alt=""
                fill
                priority
                placeholder="blur"
                quality={100}
                sizes="100vw"
                className="object-cover object-center"
            />

            {/* Dark vertical gradient overlay */}
            <div className="absolute inset-0 bg-gradient-to-b from-black/70 via-black/30 to-black/80 pointer-events-none" />

            {/* Login card */}
            <div className="relative z-10 w-full max-w-md px-10 py-12 bg-primary rounded-sm shadow-lg space-y-10">
                {/* Logo & title */}
                <div className="space-y-4">
                    <div className="flex items-center gap-3">
                        <div className="h-12 w-12 bg-black font-mono font-semibold text-white text-base flex items-center justify-center leading-tight">
                            HRB
                        </div>
                        {/*<span className="font-display text-2xl font-semibold tracking-tight uppercase">

                        </span>*/}
                    </div>
                    <p className="font-display text-2xl font-semibold tracking-tight">
                        Ogen' Harbor
                    </p>
                </div>

                {/* Features */}
                <div className="space-y-3 text-sm text-secondary-foreground">
                    Tenant orchestration and control, resource management, stats and other funny things
                </div>

                {/* Login */}
                <div className="space-y-4 pt-2">
                    <p className="text-sm text-secondary-foreground">
                        Please use your @getogen.com account to login
                    </p>
                    <Button
                        type="button"
                        variant="defaultInverted"
                        size="excluded"
                        className="w-full gap-3 justify-center h-14 px-6 text-base"
                        onClick={handleLogin}
                        disabled={loading}
                    >
                        <Image
                            src="https://www.google.com/favicon.ico"
                            alt="Google"
                            width={20}
                            height={20}
                            unoptimized
                        />
                        {loading ? "Signing in…" : "Login with Google"}
                    </Button>
                    {error && (
                        <p className="text-sm text-red-500" role="alert">
                            {error}
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}
