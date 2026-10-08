import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'

/** Top bar of every app page: sidebar toggle on desktop, optional back link, title, actions. */
export function PageHeader({ title, description, back, backOnSmall, actions, className }: {
  title: ReactNode
  description?: ReactNode
  back?: string
  /** Hide the back link on wide screens, where a list beside the page already shows where you are. */
  backOnSmall?: boolean
  actions?: ReactNode
  className?: string
}) {
  return (
    <header className={cn(
      'sticky top-0 z-20 flex min-h-14 shrink-0 items-center gap-2 border-b bg-background/85 px-3 pt-[env(safe-area-inset-top)] backdrop-blur-md md:px-4',
      className,
    )}>
      <SidebarTrigger className="-ml-1 hidden md:inline-flex" />
      <Separator orientation="vertical" className="mr-1 hidden data-[orientation=vertical]:h-4 md:block" />
      {back && (
        <Button variant="ghost" size="icon-lg" asChild className={cn('-ml-1', backOnSmall && 'lg:hidden')}>
          <Link to={back} aria-label="Back"><ArrowLeft /></Link>
        </Button>
      )}
      <div className="min-w-0 flex-1 py-2">
        <h1 className="truncate text-[15px] font-semibold leading-tight">{title}</h1>
        {description && <div className="truncate text-xs text-muted-foreground">{description}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </header>
  )
}

/** Standard content column under a PageHeader. */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-5 md:px-6 md:py-6', className)}>{children}</div>
}

/** A titled group of content inside a page. */
export function Section({ title, description, action, children, className }: {
  title?: ReactNode; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string
}) {
  return (
    <section className={cn('flex flex-col gap-3', className)}>
      {(title || action) && (
        <div className="flex items-end justify-between gap-3">
          <div>
            {title && <h2 className="text-sm font-medium">{title}</h2>}
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  )
}
