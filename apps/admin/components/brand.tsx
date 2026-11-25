import Image from "next/image";
import { cx } from "@/components/ui";

/**
 * Carbon Savers logo (Brand Book vol. 1). Never recolour, stretch or add effects to it.
 * - primary: Slate Gray wordmark + Mantis dots, on white / light backgrounds
 * - white: on dark backgrounds (Slate Gray, Navy, photos)
 * - mantis-white: Mantis wordmark + white dots, on Slate Gray or Navy
 * Clear space (cap height of "SAVERS", about 18% of the logo height) is kept by the padding.
 */
const FILES = {
  primary: "/brand/logo-primary.png",
  white: "/brand/logo-white.png",
  "mantis-white": "/brand/logo-mantis-white.png",
} as const;

export function Logo({
  variant = "primary",
  width = 140,
  className,
  priority,
}: {
  variant?: keyof typeof FILES;
  width?: number;
  className?: string;
  priority?: boolean;
}) {
  // Source artwork is 2000 × 776.
  const height = Math.round((width * 776) / 2000);
  return (
    <span className={cx("inline-block", className)} style={{ padding: Math.round(height * 0.18) }}>
      <Image
        src={FILES[variant]}
        alt="Carbon Savers"
        width={width}
        height={height}
        priority={priority}
      />
    </span>
  );
}

/** Small section label with the brand's thin Mantis rule beneath. */
export function BrandLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("text-xs font-semibold uppercase tracking-wider text-slate-500", className)}>
      {children}
      <div className="mt-1.5 h-0.5 w-6 rounded-full bg-emerald-500" />
    </div>
  );
}
