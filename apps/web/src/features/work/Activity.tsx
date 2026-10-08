import { Link } from '@tanstack/react-router'
import { Sparkles } from 'lucide-react'
import { relativeTime } from '../claude/data'
import type { Activity } from './data'

/** "Ann moved app#12 to Review, 5 min ago" — newest first. */
export function ActivityList({ items, showProject }: { items: Activity[]; showProject?: boolean }) {
  if (!items.length) return <p className="text-sm text-muted-foreground">Nothing has happened yet.</p>
  return (
    <ol className="flex flex-col">
      {items.map((a) => {
        const text = (
          <>
            <span className="font-medium">{a.user ?? 'Someone'}</span>{' '}
            {a.viaClaude && <span className="text-muted-foreground"><Sparkles className="mr-0.5 inline size-3 align-[-1px]" />via Claude </span>}{a.summary}
            {showProject && a.project && <span className="text-muted-foreground"> in {a.project.name}</span>}
          </>
        )
        return (
          <li key={a.id} className="flex items-baseline gap-3 border-l py-1.5 pl-3 text-sm">
            <span className="min-w-0 flex-1">{a.url ? <Link to={a.url} className="hover:underline">{text}</Link> : text}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(a.at)}</span>
          </li>
        )
      })}
    </ol>
  )
}
