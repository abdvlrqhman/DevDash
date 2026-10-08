import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { IconChevronRight, IconUserPlus } from '@tabler/icons-react'
import { PageHeader } from '../../app/AppShell'
import { api, meQuery, spaceQuery, unwrap } from '../../lib/api'
import { Avatar, Card } from '../../ui'

const greeting = () => {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

export function HomePage() {
  const me = useQuery(meQuery).data!
  const space = useQuery(spaceQuery).data
  const members = useQuery({ queryKey: ['members'], queryFn: () => unwrap(api.api.members.$get()) })

  return (
    <>
      <PageHeader title={`${greeting()}, ${me.name.split(' ')[0]}`} sub={space?.name} />
      <div className="px-4 lg:px-8 pb-6 flex flex-col gap-2.5 max-w-3xl">
        <Link to="/members" className="block">
          <Card className="flex items-center gap-3">
            <div className="flex -space-x-2">
              {members.data?.users.slice(0, 5).map((u) => <span key={u.id} className="ring-2 ring-surface rounded-lg"><Avatar name={u.name} seed={u.id} /></span>)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-medium">Members</div>
              <div className="text-muted text-[12px]">
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
