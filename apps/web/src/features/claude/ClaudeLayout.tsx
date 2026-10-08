import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { Plus, Search, Settings2, Sparkles } from 'lucide-react'
import { initials, StatusLight } from '@/components/app/brand'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Skeleton } from '@/components/ui/skeleton'
import { meQuery } from '@/lib/api'
import { cn } from '@/lib/utils'
import { relativeTime, sessionsQuery, shortPath, type Session } from './data'
import { NewSession, SessionsPage } from './SessionsPage'

/**
 * Claude on wide screens: the session list stays on the left while a session is open on the right
 * (master-detail). On phones each is its own screen.
 */
export function ClaudeLayout() {
  const path = useRouterState({ select: (s) => s.location.pathname })
  const withList = path !== '/claude/setup'
  return (
    <div className="flex h-full min-h-0">
      {withList && (
        <aside aria-label="Sessions" className="hidden h-full w-80 shrink-0 flex-col border-r lg:flex xl:w-[22rem]">
          <SessionsPane active={path.split('/')[2]} />
        </aside>
      )}
      <div className="h-full min-w-0 flex-1 overflow-y-auto"><Outlet /></div>
    </div>
  )
}

/** /claude: the list on phones; on wide screens the list is already on the left, so invite a choice. */
export function ClaudeIndex() {
  const [creating, setCreating] = useState(false)
  return (
    <>
      <div className="lg:hidden"><SessionsPage /></div>
      <div className="hidden h-full items-center justify-center p-8 lg:flex">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><Sparkles /></EmptyMedia>
            <EmptyTitle>Pick a session</EmptyTitle>
            <EmptyDescription>Open one from the list, or start a new one. Sessions keep running on the server when you close this.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent><Button onClick={() => setCreating(true)}><Plus />New session</Button></EmptyContent>
        </Empty>
      </div>
      <NewSession open={creating} onClose={() => setCreating(false)} />
    </>
  )
}

const light = (s: Session) => (s.status === 'working' ? 'live' : s.status === 'waiting' ? 'waiting' : s.status === 'error' ? 'error' : 'idle')
const rank = (s: Session) => (s.status === 'waiting' ? 0 : s.status === 'working' ? 1 : 2)

function SessionsPane({ active }: { active?: string }) {
  const me = useQuery(meQuery).data!
  const list = useQuery(sessionsQuery(false))
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const sessions = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (list.data?.sessions ?? [])
      .filter((s) => !needle || s.title.toLowerCase().includes(needle) || s.cwd.toLowerCase().includes(needle))
      .sort((a, b) => rank(a) - rank(b) || b.lastActivityAt - a.lastActivityAt)
  }, [list.data, q])

  return (
    <>
      <div className="flex min-h-14 items-center gap-2 border-b px-3">
        <h2 className="flex-1 text-[15px] font-semibold">Claude</h2>
        <Button variant="ghost" size="icon-sm" asChild aria-label="Claude setup"><Link to="/claude/setup"><Settings2 /></Link></Button>
        <Button size="sm" onClick={() => setCreating(true)}><Plus />New</Button>
      </div>
      <div className="p-3 pb-2">
        <InputGroup className="h-8">
          <InputGroupAddon><Search /></InputGroupAddon>
          <InputGroupInput placeholder="Filter sessions" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter sessions" />
        </InputGroup>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {list.isPending && [0, 1, 2, 3].map((i) => <Skeleton key={i} className="mx-1 mb-2 h-12" />)}
        {list.isSuccess && !sessions.length && <p className="px-2 py-6 text-center text-sm text-muted-foreground">{q ? 'No session matches.' : 'No sessions yet.'}</p>}
        <ul className="flex flex-col gap-0.5">
          {sessions.map((s) => (
            <li key={s.id}>
              <Link to="/claude/$id" params={{ id: s.id }}
                className={cn('flex items-start gap-2.5 rounded-md px-2 py-2 text-sm hover:bg-accent', s.id === active && 'bg-accent', s.status === 'waiting' && s.id !== active && 'bg-attention-soft')}>
                <StatusLight state={light(s)} className="mt-1.5" />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-1 font-medium">{s.title}</span>
                  <span className="line-clamp-1 text-xs text-muted-foreground">
                    {s.status === 'waiting' ? 'Needs you' : s.status === 'working' ? 'Working' : relativeTime(s.lastActivityAt)}, <span className="font-mono">{shortPath(s.cwd, s.owner.username)}</span>
                  </span>
                </span>
                {s.owner.id !== me.id && <Avatar className="size-6"><AvatarFallback className="text-[10px]">{initials(s.owner.name)}</AvatarFallback></Avatar>}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <NewSession open={creating} onClose={() => setCreating(false)} />
    </>
  )
}
