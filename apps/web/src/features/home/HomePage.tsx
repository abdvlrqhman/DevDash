import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronRight, Plus, Sparkles } from 'lucide-react'
import { initials, StatusLight } from '@/components/app/brand'
import { PageBody, PageHeader, Section } from '@/components/app/page'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { meQuery, spaceQuery } from '@/lib/api'
import { NewSession } from '@/features/claude/SessionsPage'
import { relativeTime, sessionsQuery, shortPath } from '@/features/claude/data'

const greeting = () => {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

export function HomePage() {
  const me = useQuery(meQuery).data!
  const space = useQuery(spaceQuery).data
  const sessions = useQuery(sessionsQuery(false))
  const [creating, setCreating] = useState(false)

  const all = sessions.data?.sessions ?? []
  const waiting = all.filter((s) => s.status === 'waiting')
  const running = all.filter((s) => s.status === 'working')
  const recent = all.filter((s) => s.status !== 'waiting' && s.status !== 'working').slice(0, 5)

  return (
    <>
      <PageHeader title={space?.name ?? 'Home'} actions={<Button size="sm" onClick={() => setCreating(true)}><Plus />New session</Button>} />
      <PageBody>
        <h2 className="text-2xl font-semibold tracking-tight">{greeting()}, {me.name.split(' ')[0]}</h2>

        {waiting.length > 0 && (
          <Section title="Needs you">
            <ItemGroup className="gap-2">
              {waiting.map((s) => (
                <Item key={s.id} asChild className="border-attention/40 bg-attention-soft">
                  <Link to="/claude/$id" params={{ id: s.id }}>
                    <ItemMedia><StatusLight state="waiting" /></ItemMedia>
                    <ItemContent>
                      <ItemTitle>{s.title}</ItemTitle>
                      <ItemDescription>Claude is waiting for your answer in <span className="font-mono">{shortPath(s.cwd, s.owner.username)}</span></ItemDescription>
                    </ItemContent>
                    <ItemActions><ChevronRight className="size-4 text-muted-foreground" /></ItemActions>
                  </Link>
                </Item>
              ))}
            </ItemGroup>
          </Section>
        )}

        <Section title="Claude" action={<Button variant="link" size="sm" asChild className="h-auto p-0"><Link to="/claude">All sessions</Link></Button>}>
          {running.length + recent.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon"><Sparkles /></EmptyMedia>
                <EmptyTitle>No sessions yet</EmptyTitle>
                <EmptyDescription>Start one and Claude works on the server as you, even after you close the app.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent><Button onClick={() => setCreating(true)}><Plus />New session</Button></EmptyContent>
            </Empty>
          ) : (
            <ItemGroup className="rounded-xl border">
              {[...running, ...recent].map((s) => (
                <Item key={s.id} asChild className="rounded-none border-0 border-b last:border-b-0">
                  <Link to="/claude/$id" params={{ id: s.id }}>
                    <ItemMedia><StatusLight state={s.status === 'working' ? 'live' : s.status === 'error' ? 'error' : 'idle'} /></ItemMedia>
                    <ItemContent>
                      <ItemTitle className="line-clamp-1">{s.title}</ItemTitle>
                      <ItemDescription className="line-clamp-1">
                        {s.status === 'working' ? 'Working' : relativeTime(s.lastActivityAt)}, <span className="font-mono">{shortPath(s.cwd, s.owner.username)}</span>
                      </ItemDescription>
                    </ItemContent>
                    {s.owner.id !== me.id && (
                      <ItemActions>
                        <Avatar className="size-7"><AvatarFallback className="text-[11px]">{initials(s.owner.name)}</AvatarFallback></Avatar>
                      </ItemActions>
                    )}
                  </Link>
                </Item>
              ))}
            </ItemGroup>
          )}
        </Section>
      </PageBody>
      <NewSession open={creating} onClose={() => setCreating(false)} />
    </>
  )
}
