import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
        outline: "text-foreground",
        // Confidence badge variants
        success:
          "border-transparent bg-emerald-500/15 text-emerald-500 dark:bg-emerald-500/20 dark:text-emerald-400",
        warning:
          "border-transparent bg-yellow-500/15 text-yellow-600 dark:bg-yellow-500/20 dark:text-yellow-400",
        caution:
          "border-transparent bg-orange-500/15 text-orange-600 dark:bg-orange-500/20 dark:text-orange-400",
        low:
          "border-transparent bg-red-500/15 text-red-600 dark:bg-red-500/20 dark:text-red-400",
        neutral:
          "border-transparent bg-slate-500/15 text-slate-600 dark:bg-slate-500/20 dark:text-slate-400",
        info:
          "border-transparent bg-blue-500/15 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400",
        // Sentiment badges
        bullish:
          "border-transparent bg-emerald-500/15 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400",
        bearish:
          "border-transparent bg-red-500/15 text-red-600 dark:bg-red-500/20 dark:text-red-400",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
