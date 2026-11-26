"use client";

import { DotsThreeIcon, XIcon } from "@phosphor-icons/react";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  CANVAS_PRESETS,
  ratioLabel,
  toCanvas,
  type CanvasDraft,
} from "./canvas";

// CanvasShape draws a size as a rectangle scaled into a size×size box, so the
// orientation reads at a glance. An unset size draws as a dashed square.
function CanvasShape({
  width,
  height,
  size,
}: {
  width: number;
  height: number;
  size: number;
}) {
  const set = width > 0 && height > 0;
  const scale = set ? size / Math.max(width, height) : 0;
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center"
      style={{ width: size + 6, height: size + 6 }}
    >
      <span
        className={cn(
          "block border-[1.5px]",
          set ? "border-secondary-foreground" : "border-dashed border-quaternary-foreground",
        )}
        style={
          set
            ? { width: Math.max(4, width * scale), height: Math.max(4, height * scale) }
            : { width: size * 0.6, height: size * 0.6 }
        }
      />
    </span>
  );
}

// CanvasField edits one post type's recommended canvas: width × height with a
// live shape and ratio, plus a menu of common sizes. Both inputs empty means
// no recommendation.
export function CanvasField({
  slug,
  value,
  onChange,
  invalid,
}: {
  slug: string;
  value: CanvasDraft;
  onChange: (next: CanvasDraft) => void;
  invalid?: boolean;
}) {
  // The shape and ratio show only for a valid size; the text stays as typed so
  // checkCanvas can report a bad one instead of it being rewritten.
  const canvas = toCanvas(value);
  const ratio = canvas ? ratioLabel(canvas.width, canvas.height) : null;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <CanvasShape width={canvas?.width ?? 0} height={canvas?.height ?? 0} size={22} />
      <Input
        aria-label={`${slug} canvas width`}
        aria-invalid={invalid || undefined}
        inputMode="numeric"
        placeholder="W"
        value={value.width}
        onChange={(e) => onChange({ ...value, width: e.target.value })}
        maxLength={6}
        className="w-[4.5rem] min-w-[3.25rem] shrink px-2 text-right tabular-nums"
        autoComplete="off"
      />
      <span className="text-xs text-tertiary-foreground">×</span>
      <Input
        aria-label={`${slug} canvas height`}
        aria-invalid={invalid || undefined}
        inputMode="numeric"
        placeholder="H"
        value={value.height}
        onChange={(e) => onChange({ ...value, height: e.target.value })}
        maxLength={6}
        className="w-[4.5rem] min-w-[3.25rem] shrink px-2 text-right tabular-nums"
        autoComplete="off"
      />
      <span
        className={cn(
          "min-w-12 px-1.5 py-0.5 text-center text-[11px] tabular-nums",
          ratio
            ? "bg-quaternary text-secondary-foreground"
            : "text-tertiary-foreground",
        )}
      >
        {ratio ?? "—"}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Canvas presets for ${slug}`}
            className="shrink-0 rounded-xs p-1.5 text-tertiary-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <DotsThreeIcon className="size-4" weight="bold" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" sideOffset={6} className="min-w-56">
          <DropdownMenuLabel>Common sizes</DropdownMenuLabel>
          {CANVAS_PRESETS.map(({ canvas, label }) => (
            <DropdownMenuItem
              key={`${canvas.width}x${canvas.height}`}
              onClick={() =>
                onChange({ width: String(canvas.width), height: String(canvas.height) })
              }
            >
              <CanvasShape width={canvas.width} height={canvas.height} size={12} />
              <span className="tabular-nums">
                {canvas.width} × {canvas.height}
              </span>
              <span className="ml-auto text-xs text-tertiary-foreground">
                {ratioLabel(canvas.width, canvas.height)} {label.toLowerCase()}
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onChange({ width: "", height: "" })}>
            <XIcon className="size-4" />
            Clear (no recommendation)
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
