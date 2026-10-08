import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { IconChevronRight, IconSparkles, IconUserPlus } from '@tabler/icons-react'
import { PageHeader } from '../../app/AppShell'
import { api, meQuery, spaceQuery, unwrap } from '../../lib/api'
import { Avatar, Card, Light } from '../../ui'
import { sessionsQuery, shortPath, useLiveSessions } from '../claude/data'

const greeting = () => {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

export function HomePage() {
  const me = useQuery(meQuery).data!
  const space = useQuery(spaceQuery).data
  const members = useQuery({ queryKey: ['members'], queryFn: () => unwrap(api.api.members.$get()) })
  const sessions = useQuery(sessionsQuery(false))
  useLiveSessions()

  const all = sessions.data?.sessions ?? []
  const waiting = all.filter((s) => s.status === 'waiting')
  const running = all.filter((s) => s.status === 'working')

  return (
    <>
      <PageHeader title={`${greeting()}, ${me.name.split(' ')[0]}`} sub={space?.name} />
      <div className="px-4 lg:px-8 pb-8 flex flex-col gap-3 max-w-3xl">
        {waiting.map((s) => (
          <Link key={s.id} to="/claude/$id" params={{ id: s.id }} className="block">
            <Card tone="brass" className="flex items-start gap-3">
              <span className="mt-[7px]"><Light state="waiting" /></span>
              <div className="flex-1 min-w-0">
                <div className="font-medium">Claude needs you</div>
                <div className="text-[14px] text-muted truncate">{s.title}, in <span className="font-mono">{shortPath(s.cwd, s.owner.username)}</span></div>
              </div>
              <IconChevronRight size={18} className="text-muted mt-1" />
            </Card>
          </Link>
        ))}

        <section className="flex flex-col">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[13px] text-muted font-normal m-0 mb-1">Claude</h2>
            <Link to="/claude" className="text-[13px] text-accent">All sessions</Link>
          </div>
          {running.length ? (
            <ul className="m-0 p-0 list-none border-t border-line">
              {running.map((s) => (
                <li key={s.id} className="border-b border-line">
                  <Link to="/claude/$id" params={{ id: s.id }} className="flex items-center gap-3 py-3">
                    <Light state="live" />
                    <span className="flex-1 min-w-0 truncate">{s.title}</span>
                    {s.owner.id !== me.id && <Avatar name={s.owner.name} seed={s.owner.id} />}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <Link to="/claude" className="flex items-center gap-3 py-3 border-y border-line text-muted">
              <IconSparkles size={18} className="text-accent shrink-0" />
              <span className="flex-1">Nothing running. Start a session and Claude keeps working after you close the app.</span>
            </Link>
          )}
        </section>

        <Link to="/members" className="block mt-2">
          <Card className="flex items-center gap-3">
            <div className="flex -space-x-2">
              {members.data?.users.slice(0, 5).map((u) => <span key={u.id} className="ring-2 ring-surface rounded-lg"><Avatar name={u.name} seed={u.id} /></span>)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-medium">Members</div>
              <div className="text-muted text-[13px]">
                {members.data ? `${members.data.users.length} in this space${members.data.invites.length ? `, ${members.data.invites.length} invited` : ''}` : 'Loading…'}
              </div>
            </div>
            {me.role === 'admin' && <IconUserPlus size={20} className="text-accent" aria-label="Invite" />}
            <IconChevronRight size={18} className="text-muted" />
          </Card>
        </Link>
      </div>
    </>
  )
}
