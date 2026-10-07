import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

const filledShadow = "shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]";

/* Pill-shaped by default — the app's core button style. Explicit symmetric
 * padding (not a fixed height) so the top/bottom spacing is always equal. */
export const buttonVariants = cva(
  `inline-flex items-center justify-center font-medium select-none
   transition-[transform,background-color,opacity] duration-150 ease-out
   active:scale-[0.96] disabled:opacity-50 disabled:pointer-events-none`,
  {
    variants: {
      variant: {
        primary: `bg-ink text-canvas hover:opacity-90 ${filledShadow}`,
        secondary: "bg-surface text-ink shadow-btn hover:bg-inset aria-expanded:bg-hover",
        ghost: "bg-hover-2 text-ink hover:bg-line-strong",
        accent: `bg-accent text-white hover:bg-accent-ink ${filledShadow}`,
        success: `bg-green text-white hover:brightness-95 ${filledShadow}`,
        quiet: "text-ink hover:bg-hover",
      },
      size: {
        xs: "h-7 rounded-full px-2.5 text-[12px] font-normal leading-none gap-1",
        sm: "h-[27px] px-3 text-[13px] leading-none rounded-full gap-1.5",
        md: "px-4 py-[9px] text-sm leading-none rounded-full gap-2",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export function Button({
  variant,
  size,
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
