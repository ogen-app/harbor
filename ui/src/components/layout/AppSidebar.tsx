"use client";

import * as React from "react";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useHotkeys } from "react-hotkeys-hook";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Tooltip,
    TooltipTrigger,
    TooltipContent,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { LogOut } from "lucide-react";
import { SidebarSimpleIcon } from "@phosphor-icons/react";
import { useAuth } from "@/components/auth/AuthProvider";
import { logout } from "@/lib/auth";

type NavItem = {
    icon:
        | "nav_portfolios"
        | "nav_ideas"
        | "nav_settings"
        | "nav_dashboard"
        | "nav_journal"
        | "nav_screening"
        | "nav_strategy"
        | "nav_watchlist"
        | "layout"
        | "tenants"
        | "database";
    label: string;
    href: string;
    active?: boolean;
};

const navItems: NavItem[] = [
    { icon: "tenants", label: "Tenants", href: "/tenants" },
    { icon: "database", label: "Databases", href: "/databases" },
    { icon: "layout", label: "Design system", href: "/design-system" },
];

const STORAGE_KEY = "sidebar-collapsed";

// initials derives up-to-two uppercase letters from a name, falling back to email.
function initials(name: string, email: string): string {
    const source = name.trim() || email;
    const parts = source.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return source.slice(0, 2).toUpperCase();
}

interface AppSidebarProps {
    defaultCollapsed?: boolean;
    className?: string;
}

export function AppSidebar({
    defaultCollapsed = false,
    className,
}: AppSidebarProps) {
    const [collapsed, setCollapsed] = useState(defaultCollapsed);
    const activeHref = usePathname();
    const router = useRouter();
    const { user } = useAuth();

    const displayName = user?.name?.trim() || user?.email || "";
    const displayEmail = user?.email ?? "";
    const avatarInitials = initials(user?.name ?? "", user?.email ?? "");

    const handleLogout = async () => {
        try {
            await logout();
        } finally {
            router.replace("/login");
        }
    };

    // Harbor serves the UI as a static export (no SSR), so restore the persisted
    // collapsed state on the client after mount instead of from a server cookie.
    useEffect(() => {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored !== null) {
            // Client-only restore after mount (no SSR) — intentional.
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setCollapsed(stored === "true");
        }
    }, []);

    const toggle = () =>
        setCollapsed((prev) => {
            const next = !prev;
            localStorage.setItem(STORAGE_KEY, String(next));
            document.cookie = `${STORAGE_KEY}=${next};path=/;max-age=31536000;SameSite=Lax`;
            return next;
        });

    useHotkeys("bracketleft", toggle, { preventDefault: true });
    useHotkeys("g>t", () => router.push("/tenants"), { preventDefault: true });
    useHotkeys("g>d", () => router.push("/databases"), { preventDefault: true });
    useHotkeys("g>s", () => router.push("/settings"), { preventDefault: true });

    return (
        <aside
            data-sidebar
            className={cn(
                "flex flex-col h-screen shrink-0 bg-sidebar border-r border-sidebar-border overflow-hidden transition-all duration-200 select-none",
                collapsed ? "w-18" : "w-70",
                className,
            )}
            style={{ zIndex: 150 }}
        >
            {/* Header */}
            <div className="flex items-center justify-between p-4 h-16 shrink-0">
                <Link href="/" className="flex items-center gap-2">
                    <div className="h-10 w-10 bg-black font-mono font-semibold text-white text-sm flex items-center justify-center leading-tight">
                        HRB
                    </div>
                </Link>
                {!collapsed && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="defaultIcon"
                                onClick={toggle}
                                aria-label="Expand navigation sidebar"
                            >
                                <SidebarSimpleIcon size={42} weight="light" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                            Expand navigation sidebar
                            <span className="font-mono ml-2">[</span>
                        </TooltipContent>
                    </Tooltip>
                )}
            </div>

            {/* Navigation */}
            <nav
                className={cn(
                    "flex flex-col gap-1 flex-1 p-3 lg:p-6",
                    !collapsed && "-ml-2",
                )}
            >
                {navItems.map((item) => {
                    const isActive = activeHref.startsWith(item.href);
                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            className={cn(
                                "flex items-center rounded-xs px-2.5 py-2 text-sm transition-colors",
                                collapsed ? "justify-center gap-0" : "gap-2.5",
                                "text-gray-500 hover:bg-sidebar-secondary hover:text-secondary-foreground",
                                isActive &&
                                    "bg-sidebar-secondary text-secondary-foreground icon-sidebar-active",
                            )}
                        >
                            <Icon
                                name={item.icon}
                                className="size-5 shrink-0 stroke-[1.5]"
                            />
                            <span
                                className={cn(
                                    "font-mono uppercase font-semibold whitespace-nowrap overflow-hidden transition-all duration-200",
                                    collapsed ? "w-0 opacity-0" : "opacity-100",
                                )}
                            >
                                {item.label}
                            </span>
                        </Link>
                    );
                })}

                {/* System group */}
                <div
                    className={cn(
                        "relative h-10 flex items-center overflow-hidden transition-all duration-200",
                        collapsed
                            ? "opacity-0 pointer-events-none"
                            : "opacity-100",
                    )}
                >
                    <div className="absolute top-1/2 h-px w-full bg-sidebar-border" />
                    <span className="absolute px-3 text-[11px] font-medium tracking-[0.03em] text-sidebar-secondary-foreground bg-sidebar ml-5">
                        SYSTEM
                    </span>
                </div>

                <Link
                    href="/settings"
                    className={cn(
                        "flex items-center rounded-xs px-2.5 py-2 text-sm transition-colors",
                        collapsed ? "justify-center gap-0" : "gap-2.5",
                        "text-gray-500 hover:bg-sidebar-secondary hover:text-secondary-foreground",
                        activeHref.startsWith("/settings") &&
                            "bg-sidebar-secondary text-sidebar-primary-foreground icon-sidebar-active",
                    )}
                >
                    <Icon
                        name="nav_settings"
                        className="size-5 shrink-0 stroke-[1.5]"
                    />
                    <span
                        className={cn(
                            "font-mono uppercase font-semibold whitespace-nowrap overflow-hidden transition-all duration-200",
                            collapsed ? "w-0 opacity-0" : "opacity-100",
                        )}
                    >
                        Settings
                    </span>
                </Link>

                {/* Services group */}
                <div
                    className={cn(
                        "relative h-10 flex items-center overflow-hidden transition-all duration-200",
                        collapsed
                            ? "opacity-0 pointer-events-none"
                            : "opacity-100",
                    )}
                >
                    <div className="absolute top-1/2 h-px w-full bg-sidebar-border" />
                    <span className="absolute px-3 text-[11px] font-medium tracking-[0.03em] text-sidebar-secondary-foreground bg-sidebar ml-5">
                        SERVICES
                    </span>
                </div>

                <a
                    href="https://aistudio.google.com/usage?timeRange=last-7-days&project=gen-lang-client-0756755976"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                        "flex items-center rounded-xs px-2.5 py-2 text-sm transition-colors",
                        collapsed ? "justify-center gap-0" : "gap-2.5",
                        "text-gray-500 hover:bg-sidebar-secondary hover:text-secondary-foreground",
                    )}
                >
                    <Icon
                        name="ai_studio"
                        className="size-5 shrink-0 stroke-[1.5]"
                    />
                    <span
                        className={cn(
                            "font-mono uppercase font-semibold whitespace-nowrap overflow-hidden transition-all duration-200",
                            collapsed ? "w-0 opacity-0" : "opacity-100",
                        )}
                    >
                        Google AI Studio
                    </span>
                </a>

                <a
                    href="https://platform.claude.com/usage"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                        "flex items-center rounded-xs px-2.5 py-2 text-sm transition-colors",
                        collapsed ? "justify-center gap-0" : "gap-2.5",
                        "text-gray-500 hover:bg-sidebar-secondary hover:text-secondary-foreground",
                    )}
                >
                    <Icon
                        name="claude"
                        className="size-5 shrink-0 stroke-[1.5]"
                    />
                    <span
                        className={cn(
                            "font-mono uppercase font-semibold whitespace-nowrap overflow-hidden transition-all duration-200",
                            collapsed ? "w-0 opacity-0" : "opacity-100",
                        )}
                    >
                        Claude Console
                    </span>
                </a>

                <a
                    href="https://dash.cloudflare.com/17efea3963b045025b9ecbdcad609273/r2/overview"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                        "flex items-center rounded-xs px-2.5 py-2 text-sm transition-colors",
                        collapsed ? "justify-center gap-0" : "gap-2.5",
                        "text-gray-500 hover:bg-sidebar-secondary hover:text-secondary-foreground",
                    )}
                >
                    <Icon
                        name="cloudflare"
                        className="size-5 shrink-0 stroke-[1.5]"
                    />
                    <span
                        className={cn(
                            "font-mono uppercase font-semibold whitespace-nowrap overflow-hidden transition-all duration-200",
                            collapsed ? "w-0 opacity-0" : "opacity-100",
                        )}
                    >
                        Cloudflare R2
                    </span>
                </a>

                <a
                    href="https://zernio.com/dashboard/connections"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                        "flex items-center rounded-xs px-2.5 py-2 text-sm transition-colors",
                        collapsed ? "justify-center gap-0" : "gap-2.5",
                        "text-gray-500 hover:bg-sidebar-secondary hover:text-secondary-foreground",
                    )}
                >
                    <Icon
                        name="zernio"
                        className="size-5 shrink-0 stroke-[1.5]"
                    />
                    <span
                        className={cn(
                            "font-mono uppercase font-semibold whitespace-nowrap overflow-hidden transition-all duration-200",
                            collapsed ? "w-0 opacity-0" : "opacity-100",
                        )}
                    >
                        Zernio
                    </span>
                </a>

                <a
                    href="https://railway.com/project/e475ca33-45d9-4dd1-b996-b4292ff20378"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                        "flex items-center rounded-xs px-2.5 py-2 text-sm transition-colors",
                        collapsed ? "justify-center gap-0" : "gap-2.5",
                        "text-gray-500 hover:bg-sidebar-secondary hover:text-secondary-foreground",
                    )}
                >
                    <Icon
                        name="railway"
                        className="size-5 shrink-0 stroke-[1.5]"
                    />
                    <span
                        className={cn(
                            "font-mono uppercase font-semibold whitespace-nowrap overflow-hidden transition-all duration-200",
                            collapsed ? "w-0 opacity-0" : "opacity-100",
                        )}
                    >
                        Railway
                    </span>
                </a>

                <a
                    href="https://github.com/ogen-app"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                        "flex items-center rounded-xs px-2.5 py-2 text-sm transition-colors",
                        collapsed ? "justify-center gap-0" : "gap-2.5",
                        "text-gray-500 hover:bg-sidebar-secondary hover:text-secondary-foreground",
                    )}
                >
                    <Icon
                        name="github"
                        className="size-5 shrink-0 stroke-[1.5]"
                    />
                    <span
                        className={cn(
                            "font-mono uppercase font-semibold whitespace-nowrap overflow-hidden transition-all duration-200",
                            collapsed ? "w-0 opacity-0" : "opacity-100",
                        )}
                    >
                        GitHub
                    </span>
                </a>
            </nav>

            {/* Footer / User */}
            <div className="p-4 border-t border-sidebar-border">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <div
                            role="button"
                            tabIndex={0}
                            className="flex items-center gap-3 cursor-pointer overflow-hidden"
                        >
                            <Avatar className="size-9 shrink-0">
                                {user?.picture ? (
                                    <AvatarImage src={user.picture} alt={displayName} />
                                ) : null}
                                <AvatarFallback>{avatarInitials}</AvatarFallback>
                            </Avatar>
                            {!collapsed && (
                                <div className="flex flex-col min-w-0">
                                    <p className="text-sm font-medium truncate">
                                        {displayName}
                                    </p>
                                    <p className="text-xs text-tertiary-foreground truncate">
                                        {displayEmail}
                                    </p>
                                </div>
                            )}
                        </div>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                        className="w-64 px-6 pt-6 pb-4 shadow-md"
                        side="right"
                        align="end"
                        sideOffset={8}
                    >
                        <DropdownMenuLabel className="harbor-current-user-info font-normal p-0" asChild>
                            <div className="flex flex-col space-y-1 mb-4">
                                <div className="h-8 text-xl font-display font-medium truncate">
                                    {displayName}
                                </div>
                                <div className="text-sm leading-none text-tertiary-foreground">
                                    {displayEmail}
                                </div>
                            </div>
                        </DropdownMenuLabel>
                        <DropdownMenuItem size="lg" onClick={handleLogout}>
                            <LogOut className="size-4" />
                            <span>Log out</span>
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </aside>
    );
}
