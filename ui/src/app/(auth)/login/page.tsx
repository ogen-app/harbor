import { Button } from "@/components/ui/button";
import Image from "next/image";
import loginBg from "@/assets/illustrations/login-bg.jpg";

export default function LoginPage() {
    return (
        <div className="relative min-h-screen flex items-center justify-end overflow-hidden">
            {/* Full-page background image */}
            <Image
                src={loginBg}
                alt=""
                fill
                priority
                placeholder="blur"
                quality={100}
                sizes="100vw"
                className="object-cover object-left"
            />

            {/* Login card */}
            <div className="relative z-10 w-full max-w-md mr-[8%] px-10 py-12 bg-primary rounded-sm shadow-lg space-y-10">
                {/* Logo & title */}
                <div className="space-y-4">
                    <div className="flex items-center gap-3">
                        <div className="h-12 w-12 bg-black font-mono font-semibold text-white text-base flex items-center justify-center leading-tight">
                            DA
                        </div>
                        <span className="font-display text-2xl font-semibold tracking-tight uppercase">
                            DA&apos;AT Atlas
                        </span>
                    </div>
                    <p className="text-base text-secondary-foreground">
                        AI-powered delivery audit and management platform
                    </p>
                </div>

                {/* Feature points */}
                <ul className="space-y-3 text-sm text-secondary-foreground">
                    <li className="flex items-start gap-2.5">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-foreground" />
                        Automated delivery audits with AI-driven anomaly detection
                    </li>
                    <li className="flex items-start gap-2.5">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-foreground" />
                        Real-time tracking and compliance monitoring across carriers
                    </li>
                    <li className="flex items-start gap-2.5">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-foreground" />
                        Intelligent document processing and cost reconciliation
                    </li>
                    <li className="flex items-start gap-2.5">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-foreground" />
                        Actionable insights and performance analytics dashboard
                    </li>
                </ul>

                {/* Login */}
                <div className="space-y-4 pt-2">
                    <p className="text-sm text-secondary-foreground">
                        Please use your @daat.ua account to login
                    </p>
                    <Button
                        type="button"
                        variant="defaultInverted"
                        size="excluded"
                        className="w-full gap-3 justify-center h-14 px-6 text-base"
                    >
                        <Image
                            src="https://www.google.com/favicon.ico"
                            alt="Google"
                            width={20}
                            height={20}
                            unoptimized
                        />
                        Login with Google
                    </Button>
                </div>
            </div>
        </div>
    );
}
