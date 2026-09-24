"use client";

import * as React from "react";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useHotkeys } from "react-hotkeys-hook";
import { Button } from "@/components/ui/button";
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
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
    UserFullViewIcon,
    Activity03Icon,
    Database01Icon,
    AuthorizedIcon,
    UserGroupIcon,
    MailSetting01Icon,
    FactoryIcon,
    ConferenceIcon,
    LinkSquare01Icon,
    Megaphone02Icon,
    AiGenerativeIcon,
} from "@hugeicons/core-free-icons";
import { useAuth } from "@/components/auth/AuthProvider";
import { logout } from "@/lib/auth";

// Nav items render Hugeicons (https://hugeicons.com) via <HugeiconsIcon/>, taking
// the icon's SVG data object from @hugeicons/core-free-icons. Grouped into
// labelled sections; the external service dashboards live on the /links page.
type NavItem = {
    icon: IconSvgElement;
    label: string;
    href: string;
};

const NAV_GROUPS: { header: string; items: NavItem[] }[] = [
    {
        header: "Tenants",
        items: [
            { icon: UserFullViewIcon, label: "Tenants", href: "/tenants" },
            { icon: Activity03Icon, label: "Activity", href: "/activity" },
            {
                icon: UserGroupIcon,
                label: "Tiers and groups",
                href: "/tiers-and-groups",
            },
            {
                icon: ConferenceIcon,
                label: "Tier entitlements",
                href: "/tier-entitlements",
            },
            {
                icon: Megaphone02Icon,
                label: "Announcements",
                href: "/announcements",
            },
        ],
    },
    {
        header: "System",
        items: [
            { icon: Database01Icon, label: "Databases", href: "/databases" },
        ],
    },
    {
        header: "Settings",
        items: [
            { icon: FactoryIcon, label: "Platforms", href: "/platforms" },
            {
                icon: AiGenerativeIcon,
                label: "AI models",
                href: "/ai-models",
            },
            {
                icon: MailSetting01Icon,
                label: "Email templates",
                href: "/email-templates",
            },
            { icon: AuthorizedIcon, label: "Secrets", href: "/secrets" },
        ],
    },
    {
        header: "Resources",
        items: [{ icon: LinkSquare01Icon, label: "Links", href: "/links" }],
    },
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
    useHotkeys("g>g", () => router.push("/"), { preventDefault: true });
    useHotkeys("g>t", () => router.push("/tenants"), { preventDefault: true });
    useHotkeys("g>a", () => router.push("/activity"), { preventDefault: true });
    useHotkeys("g>d", () => router.push("/databases"), { preventDefault: true });
    useHotkeys("g>s", () => router.push("/secrets"), { preventDefault: true });
    useHotkeys("g>p", () => router.push("/platforms"), { preventDefault: true });
    useHotkeys("g>m", () => router.push("/ai-models"), {
        preventDefault: true,
    });
    useHotkeys("g>e", () => router.push("/tier-entitlements"), {
        preventDefault: true,
    });
    useHotkeys("g>n", () => router.push("/announcements"), {
        preventDefault: true,
    });
    useHotkeys("g>l", () => router.push("/links"), { preventDefault: true });

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
                    <div className="h-10 w-10 bg-black font-semibold text-white text-sm flex items-center justify-center leading-tight">
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
                            <span className="ml-2">[</span>
                        </TooltipContent>
                    </Tooltip>
                )}
            </div>

            {/* Navigation — grouped, labelled sections. */}
            <nav
                className={cn(
                    "flex flex-col gap-2 flex-1 min-h-0 overflow-y-auto p-3 lg:p-6",
                    !collapsed && "-ml-2",
                )}
            >
                {NAV_GROUPS.map((group) => (
                    <div key={group.header} className="flex flex-col gap-1">
                        {/* Group header — the divider label; hidden (but space
                            kept) when collapsed. */}
                        <div
                            className={cn(
                                "relative h-10 flex items-center overflow-hidden transition-all duration-200",
                                collapsed
                                    ? "opacity-0 pointer-events-none"
                                    : "opacity-100",
                            )}
                        >
                            <div className="absolute top-1/2 h-px w-full bg-sidebar-border" />
                            <span className="absolute px-3 text-[11px] font-medium uppercase tracking-[0.03em] text-sidebar-secondary-foreground bg-sidebar ml-5">
                                {group.header}
                            </span>
                        </div>

                        {group.items.map((item) => {
                            const isActive = activeHref.startsWith(item.href);
                            return (
                                <Link
                                    key={item.href}
                                    href={item.href}
                                    className={cn(
                                        "flex items-center rounded-xs px-2.5 py-2 text-sm transition-colors",
                                        collapsed
                                            ? "justify-center gap-0"
                                            : "gap-2.5",
                                        "text-gray-500 hover:bg-sidebar-secondary hover:text-secondary-foreground",
                                        isActive &&
                                            "bg-sidebar-secondary text-sidebar-primary-foreground icon-sidebar-active",
                                    )}
                                >
                                    <HugeiconsIcon
                                        icon={item.icon}
                                        className="size-5 shrink-0"
                                    />
                                    <span
                                        className={cn(
                                            "uppercase font-semibold whitespace-nowrap overflow-hidden transition-all duration-200 text-[12px]",
                                            collapsed
                                                ? "w-0 opacity-0"
                                                : "opacity-100",
                                        )}
                                    >
                                        {item.label}
                                    </span>
                                </Link>
                            );
                        })}
                    </div>
                ))}
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
