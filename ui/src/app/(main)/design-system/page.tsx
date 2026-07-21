import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Icon } from "@/components/ui/icon";
import Image from "next/image";

export default function DesignSystemPage() {
    return (
        <main className="flex-1 overflow-auto">
            {/* Page Header */}
            <header className="h-14 border-b border-border flex items-center justify-between px-6 bg-primary">
                <div className="flex items-center gap-3">
                    <h1 className="text-sm font-medium">
                        Design System Showcase
                    </h1>
                </div>
                <div className="flex items-center gap-2">
                    {/*<Button variant="outline" size="sm">
                        <Icon name="filter_empty" className="size-4" />
                        Filter
                    </Button>*/}
                    <Button size="lg">
                        <Icon name="plus" className="size-4" />
                        New Item
                    </Button>
                </div>
            </header>

            <div className="p-8 space-y-12">
                {/* Typography */}
                <section className="space-y-4">
                    <h2 className="text-xs font-medium tracking-[0.08em] uppercase text-tertiary-foreground">
                        Typography
                    </h2>
                    <div className="bg-background rounded-sm p-6 space-y-4">
                        <p className="font-display text-3xl font-semibold">
                            Display — Zalando Sans Semi Expanded
                        </p>
                        <p className="font-sans text-xl font-medium">
                            Body — Zalando Sans Variable
                        </p>
                        <p className="font-mono text-base">
                            Mono — Space Grotesk Variable
                        </p>
                        <div className="flex gap-6 flex-wrap text-sm text-secondary-foreground">
                            <span className="font-light">Light 300</span>
                            <span className="font-normal">Regular 400</span>
                            <span className="font-medium">Medium 500</span>
                            <span className="font-semibold">Semibold 600</span>
                            <span className="font-bold">Bold 700</span>
                        </div>
                    </div>
                </section>

                <Separator />

                {/* Color Palette */}
                <section className="space-y-4">
                    <h2 className="text-xs font-medium tracking-[0.08em] uppercase text-tertiary-foreground">
                        Color Palette — Beige Scale
                    </h2>
                    <div className="grid grid-cols-5 sm:grid-cols-10 gap-2">
                        {[
                            { label: "050", bg: "bg-beige-050" },
                            { label: "100", bg: "bg-beige-100" },
                            { label: "200", bg: "bg-beige-200" },
                            { label: "300", bg: "bg-beige-300" },
                            { label: "400", bg: "bg-beige-400" },
                            { label: "500", bg: "bg-beige-500" },
                            { label: "600", bg: "bg-beige-600" },
                            { label: "700", bg: "bg-beige-700" },
                            { label: "800", bg: "bg-beige-800" },
                            { label: "900", bg: "bg-beige-900" },
                        ].map(({ label, bg }) => (
                            <div key={label} className="space-y-1.5">
                                <div
                                    className={`${bg} h-12 rounded-sm border border-border`}
                                />
                                <p className="text-[11px] text-tertiary-foreground font-mono">
                                    {label}
                                </p>
                            </div>
                        ))}
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
                        {[
                            { label: "Positive", cls: "bg-positive" },
                            { label: "Negative", cls: "bg-negative" },
                            { label: "Destructive", cls: "bg-destructive" },
                            {
                                label: "Editable",
                                cls: "bg-[oklch(0.4895_0.2063_260.59)]",
                            },
                        ].map(({ label, cls }) => (
                            <div
                                key={label}
                                className="flex items-center gap-2"
                            >
                                <div
                                    className={`${cls} size-4 rounded-sm shrink-0`}
                                />
                                <span className="text-xs text-secondary-foreground">
                                    {label}
                                </span>
                            </div>
                        ))}
                    </div>
                </section>

                <Separator />

                {/* Chart Colors */}
                <section className="space-y-4">
                    <h2 className="text-xs font-medium tracking-[0.08em] uppercase text-tertiary-foreground">
                        Chart Colors
                    </h2>
                    <div className="flex gap-3 flex-wrap">
                        {[
                            { label: "Chart 1", cls: "bg-chart-1" },
                            { label: "Chart 2", cls: "bg-chart-2" },
                            { label: "Chart 3", cls: "bg-chart-3" },
                            { label: "Chart 4", cls: "bg-chart-4" },
                            { label: "Chart 5", cls: "bg-chart-5" },
                            {
                                label: "Direct",
                                cls: "bg-chart-asset-class-direct",
                            },
                            {
                                label: "Country Base",
                                cls: "bg-chart-country-base",
                            },
                            {
                                label: "Domicile",
                                cls: "bg-chart-country-domicile",
                            },
                            {
                                label: "Currency",
                                cls: "bg-chart-currency-trading",
                            },
                        ].map(({ label, cls }) => (
                            <div
                                key={label}
                                className="flex items-center gap-2"
                            >
                                <div className={`${cls} size-5 rounded-sm`} />
                                <span className="text-xs text-secondary-foreground">
                                    {label}
                                </span>
                            </div>
                        ))}
                    </div>
                </section>

                <Separator />

                {/* Buttons */}
                <section className="space-y-4">
                    <h2 className="text-xs font-medium tracking-[0.08em] uppercase text-tertiary-foreground">
                        Buttons
                    </h2>
                    <div className="bg-primary rounded-sm p-6 space-y-6">
                        {/* Default / sizes */}
                        <div>
                            <p className="text-[11px] text-tertiary-foreground mb-3">
                                Default variant — sizes
                            </p>
                            <div className="flex items-end gap-3 flex-wrap">
                                <Button size="sm">Small</Button>
                                <Button size="default">Default</Button>
                                <Button size="lg">Large</Button>
                                <Button size="xl">XL</Button>
                                <Button size="smIcon">
                                    <Icon name="plus" className="size-4" />
                                </Button>
                                <Button size="defaultIcon">
                                    <Icon name="plus" className="size-4" />
                                </Button>
                                <Button size="lgIcon">
                                    <Icon name="settings" className="size-4" />
                                </Button>
                            </div>
                        </div>
                        {/* Variants */}
                        <div>
                            <p className="text-[11px] text-tertiary-foreground mb-3">
                                Variants
                            </p>
                            <div className="flex items-center gap-3 flex-wrap">
                                <Button variant="default">Default</Button>
                                <Button variant="secondary">Secondary</Button>
                                <Button variant="outline">Outline</Button>
                                <Button variant="ghost">Ghost</Button>
                                <Button variant="destructive">
                                    Destructive
                                </Button>
                                <Button variant="link">Link</Button>
                            </div>
                        </div>
                        {/* Inverted on dark bg */}
                        <div className="bg-foreground rounded-sm p-4">
                            <p className="text-[11px] text-beige-600 mb-3">
                                Inverted (on dark bg)
                            </p>
                            <div className="flex items-center gap-3 flex-wrap">
                                <Button variant="defaultInverted">
                                    Default Inverted
                                </Button>
                                <Button variant="destructiveInverted">
                                    Destructive Inverted
                                </Button>
                            </div>
                        </div>
                        {/* Active states */}
                        <div>
                            <p className="text-[11px] text-tertiary-foreground mb-3">
                                Active states
                            </p>
                            <div className="flex items-center gap-3 flex-wrap">
                                <Button variant="default" active>
                                    Default Active
                                </Button>
                                <Button variant="ghost" active>
                                    Ghost Active
                                </Button>
                                <Button variant="outline" active>
                                    Outline Active
                                </Button>
                            </div>
                        </div>
                        {/* Disabled */}
                        <div>
                            <p className="text-[11px] text-tertiary-foreground mb-3">
                                Disabled
                            </p>
                            <div className="flex items-center gap-3 flex-wrap">
                                <Button disabled>Disabled</Button>
                                <Button variant="outline" disabled>
                                    Outline Disabled
                                </Button>
                            </div>
                        </div>
                        {/* With icons */}
                        <div>
                            <p className="text-[11px] text-tertiary-foreground mb-3">
                                With icons
                            </p>
                            <div className="flex items-center gap-3 flex-wrap">
                                <Button>
                                    <Icon name="plus" className="size-4" />
                                    Add Content
                                </Button>
                                <Button variant="outline">
                                    <Icon name="edit" className="size-4" />
                                    Edit
                                </Button>
                                <Button variant="ghost">
                                    <Icon
                                        name="filter_empty"
                                        className="size-4"
                                    />
                                    Filter
                                </Button>
                                <Button variant="destructive">
                                    <Icon name="trash_bin" className="size-4" />
                                    Delete
                                </Button>
                            </div>
                        </div>
                    </div>
                </section>

                <Separator />

                {/* Inputs */}
                <section className="space-y-4">
                    <h2 className="text-xs font-medium tracking-[0.08em] uppercase text-tertiary-foreground">
                        Inputs
                    </h2>
                    <div className="bg-primary rounded-sm p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="space-y-1.5">
                            <Label htmlFor="default-input">Default Input</Label>
                            <Input
                                id="default-input"
                                variant="default"
                                placeholder="Enter text…"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="primary-input">Primary Input</Label>
                            <Input
                                id="primary-input"
                                variant="primary"
                                placeholder="Enter text…"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="search-input">Search Input</Label>
                            <div className="flex items-center border-b border-quaternary bg-input">
                                <Icon
                                    name="search"
                                    className="size-4 ml-3 text-tertiary-foreground shrink-0"
                                />
                                <Input
                                    id="search-input"
                                    variant="search"
                                    placeholder="Search…"
                                />
                            </div>
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="disabled-input">Disabled</Label>
                            <Input
                                id="disabled-input"
                                variant="default"
                                placeholder="Disabled…"
                                disabled
                            />
                        </div>
                    </div>
                </section>

                <Separator />

                {/* Icons */}
                <section className="space-y-4">
                    <h2 className="text-xs font-medium tracking-[0.08em] uppercase text-tertiary-foreground">
                        Icons (48 total)
                    </h2>
                    <div className="bg-primary rounded-sm p-6">
                        <div className="grid grid-cols-8 sm:grid-cols-12 gap-4">
                            {(
                                [
                                    "arrow_down_pointed",
                                    "arrow_left",
                                    "arrow_right",
                                    "arrow_right_top",
                                    "arrow_up_pointed",
                                    "burger",
                                    "calendar",
                                    "change",
                                    "check",
                                    "chevron_double_left",
                                    "chevron_double_right",
                                    "chevron_down",
                                    "chevron_left",
                                    "chevron_right",
                                    "chevron_up",
                                    "collapse_top",
                                    "comment",
                                    "dots_2_vertical",
                                    "dots_drag_vertical",
                                    "edit",
                                    "empty",
                                    "exit",
                                    "filter_empty",
                                    "layout",
                                    "nav_dashboard",
                                    "nav_ideas",
                                    "nav_journal",
                                    "nav_portfolios",
                                    "nav_screening",
                                    "nav_settings",
                                    "nav_strategy",
                                    "nav_watchlist",
                                    "plus",
                                    "search",
                                    "settings",
                                    "trash_bin",
                                    "trend_down",
                                    "trend_stable",
                                    "trend_up",
                                    "uncollapse_top",
                                    "widget_maximize",
                                    "widget_minimize",
                                    "x_mark",
                                ] as const
                            ).map((name) => (
                                <div
                                    key={name}
                                    className="flex flex-col items-center gap-1.5 group"
                                    title={name}
                                >
                                    <div className="size-9 flex items-center justify-center rounded-sm hover:bg-secondary transition-colors">
                                        <Icon
                                            name={name}
                                            className="size-5 text-foreground"
                                        />
                                    </div>
                                    <span className="text-[9px] text-tertiary-foreground text-center leading-tight hidden sm:block truncate w-full text-center">
                                        {name.replace(/_/g, " ")}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                </section>

                <Separator />

                {/* Nav Icons Active State */}
                <section className="space-y-4">
                    <h2 className="text-xs font-medium tracking-[0.08em] uppercase text-tertiary-foreground">
                        Nav Icons — Active State
                    </h2>
                    <div className="bg-primary rounded-sm p-6 flex gap-4">
                        {(
                            [
                                "nav_dashboard",
                                "nav_ideas",
                                "nav_portfolios",
                                "nav_settings",
                                "nav_journal",
                            ] as const
                        ).map((name) => (
                            <div
                                key={name}
                                className="flex flex-col items-center gap-2"
                            >
                                <div className="size-9 flex items-center justify-center rounded-sm bg-sidebar-secondary icon-sidebar-active">
                                    <Icon name={name} className="size-5" />
                                </div>
                                <span className="text-[10px] text-tertiary-foreground">
                                    {name.replace("nav_", "")}
                                </span>
                            </div>
                        ))}
                    </div>
                </section>

                <Separator />

                {/* Avatar */}
                <section className="space-y-4">
                    <h2 className="text-xs font-medium tracking-[0.08em] uppercase text-tertiary-foreground">
                        Avatars
                    </h2>
                    <div className="bg-primary rounded-sm p-6 flex gap-4 items-end">
                        {[
                            "size-8",
                            "size-9",
                            "size-10",
                            "size-12",
                            "size-16",
                        ].map((sz) => (
                            <Avatar key={sz} className={sz}>
                                <AvatarFallback>JD</AvatarFallback>
                            </Avatar>
                        ))}
                    </div>
                </section>

                <Separator />

                {/* Table preview */}
                <section className="space-y-4">
                    <h2 className="text-xs font-medium tracking-[0.08em] uppercase text-tertiary-foreground">
                        Table Styles
                    </h2>
                    <div className="bg-primary rounded-sm overflow-hidden border border-border">
                        <table className="w-full">
                            <thead>
                                <tr className="bg-table-header">
                                    <th className="text-left px-4 py-2.5 table-text font-semibold text-tertiary-foreground">
                                        Audit
                                    </th>
                                    <th className="text-left px-4 py-2.5 table-text font-semibold text-tertiary-foreground">
                                        Status
                                    </th>
                                    <th className="text-right px-4 py-2.5 table-text font-semibold text-tertiary-foreground">
                                        Items
                                    </th>
                                    <th className="text-right px-4 py-2.5 table-text font-semibold text-tertiary-foreground">
                                        Trend
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {[
                                    {
                                        name: "Summer Audit",
                                        status: "Active",
                                        items: 24,
                                        trend: "up",
                                    },
                                    {
                                        name: "Brand Refresh",
                                        status: "Draft",
                                        items: 12,
                                        trend: "stable",
                                    },
                                    {
                                        name: "Q4 Strategy",
                                        status: "Review",
                                        items: 38,
                                        trend: "down",
                                    },
                                    {
                                        name: "Holiday Push",
                                        status: "Active",
                                        items: 7,
                                        trend: "up",
                                    },
                                ].map((row, i) => (
                                    <tr
                                        key={i}
                                        className="bg-table-row border-t border-border hover:bg-table-row-hover transition-colors"
                                    >
                                        <td className="px-4 py-2.5 table-text-accented">
                                            {row.name}
                                        </td>
                                        <td className="px-4 py-2.5 table-text text-secondary-foreground">
                                            {row.status}
                                        </td>
                                        <td className="px-4 py-2.5 table-text text-right font-mono">
                                            {row.items}
                                        </td>
                                        <td className="px-4 py-2.5 text-right">
                                            <Icon
                                                name={
                                                    `trend_${row.trend}` as
                                                        | "trend_up"
                                                        | "trend_down"
                                                        | "trend_stable"
                                                }
                                                className={`size-4 ml-auto ${
                                                    row.trend === "up"
                                                        ? "text-positive"
                                                        : row.trend === "down"
                                                          ? "text-negative"
                                                          : "text-tertiary-foreground"
                                                }`}
                                            />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                            <tfoot>
                                <tr className="bg-table-footer border-t border-border">
                                    <td
                                        colSpan={2}
                                        className="px-4 py-2.5 table-text text-tertiary-foreground"
                                    >
                                        4 audits
                                    </td>
                                    <td className="px-4 py-2.5 table-text-accented text-right font-mono">
                                        81
                                    </td>
                                    <td />
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </section>

                <Separator />

                {/* Shadows */}
                <section className="space-y-4">
                    <h2 className="text-xs font-medium tracking-[0.08em] uppercase text-tertiary-foreground">
                        Shadows
                    </h2>
                    <div className="flex gap-6 flex-wrap">
                        <div className="bg-primary rounded-sm p-6 shadow-md text-sm">
                            shadow-md
                        </div>
                        <div className="bg-primary rounded-sm p-6 shadow-lg text-sm">
                            shadow-lg
                        </div>
                    </div>
                </section>

                <Separator />

                {/* Animations */}
                <section className="space-y-4">
                    <h2 className="text-xs font-medium tracking-[0.08em] uppercase text-tertiary-foreground">
                        Animations
                    </h2>
                    <div className="flex gap-6 flex-wrap items-center">
                        <div className="flex flex-col items-center gap-2">
                            <div className="animate-pulse-opacity size-12 bg-foreground rounded-sm" />
                            <span className="text-xs text-tertiary-foreground">
                                pulse-opacity
                            </span>
                        </div>
                        <div className="flex flex-col items-center gap-2">
                            <div className="group cursor-pointer">
                                <Image
                                    src="/apple-touch-icon.png"
                                    alt="Float demo"
                                    width={48}
                                    height={48}
                                    className="animate-float-on-hover rounded-sm"
                                />
                            </div>
                            <span className="text-xs text-tertiary-foreground">
                                float (hover)
                            </span>
                        </div>
                        <div className="flex flex-col items-center gap-2">
                            <div className="relative h-0.5 w-24 bg-quaternary rounded-full overflow-hidden">
                                <div className="absolute inset-0 bg-foreground animate-[spinner-line_0.7s_cubic-bezier(0,0,0.03,0.9)_infinite]" />
                            </div>
                            <span className="text-xs text-tertiary-foreground">
                                spinner-line
                            </span>
                        </div>
                    </div>
                </section>

                <Separator />

                {/* Background decorations */}
                <section className="space-y-4">
                    <h2 className="text-xs font-medium tracking-[0.08em] uppercase text-tertiary-foreground">
                        Background Utilities
                    </h2>
                    <div className="space-y-3">
                        <div className="h-12 background-fader-1 bg-beige-100 flex items-center justify-center">
                            <span className="text-xs text-tertiary-foreground">
                                .background-fader-1
                            </span>
                        </div>
                        <div className="h-12 background-fader-2 bg-beige-100 flex items-center justify-center">
                            <span className="text-xs text-tertiary-foreground">
                                .background-fader-2
                            </span>
                        </div>
                    </div>
                </section>

                <Separator />

                {/* Illustrations */}
                <section className="space-y-4">
                    <h2 className="text-xs font-medium tracking-[0.08em] uppercase text-tertiary-foreground">
                        Illustrations
                    </h2>
                    <div className="bg-primary rounded-sm p-8 flex items-center justify-center">
                        <Image
                            src="/illustrations/folder-empty.webp"
                            alt="Empty folder"
                            width={120}
                            height={120}
                            className="opacity-70"
                        />
                    </div>
                </section>
            </div>
        </main>
    );
}
