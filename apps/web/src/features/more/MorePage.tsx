import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowLeftRight, ChevronRight, Download, LogOut, Server, Settings, Sparkles, Users } from 'lucide-react'
import { initials } from '@/components/app/brand'
import { PageBody, PageHeader, Section } from '@/components/app/page'
import { useSignOut } from '@/components/app/shell'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { meQuery } from '@/lib/api'
import { APP_DOWNLOADS, inShell, openExternal } from '@/lib/shell'
import { setTheme, useTheme, type ThemePref } from '@/lib/theme'

const LINKS = [
  { to: '/services', label: 'Services', description: 'Websites, APIs and containers that stay up', icon: Server },
  { to: '/members', label: 'Members', description: 'Invite people and see who has access', icon: Users },
  { to: '/claude/setup', label: 'Claude setup', description: 'Profiles, sign-in and defaults', icon: Sparkles },
  { to: '/account', label: 'Account', description: 'Password, email and appearance', icon: Settings },
] as const

/** Phone navigation for everything that doesn't fit in the bottom tabs. */
export function MorePage() {
  const me = useQuery(meQuery).data!
  const theme = useTheme()
  const signOut = useSignOut()
  return (
    <>
      <PageHeader title="More" />
      <PageBody>
        <Item variant="muted">
          <ItemMedia><Avatar className="size-10"><AvatarFallback>{initials(me.name)}</AvatarFallback></Avatar></ItemMedia>
          <ItemContent>
            <ItemTitle>{me.name}</ItemTitle>
            <ItemDescription>{me.email}</ItemDescription>
          </ItemContent>
        </Item>
        <ItemGroup className="rounded-xl border">
          {LINKS.map((l) => (
            <Item key={l.to} asChild className="rounded-none border-0 border-b last:border-b-0">
              <Link to={l.to}>
                <ItemMedia variant="icon"><l.icon /></ItemMedia>
                <ItemContent><ItemTitle>{l.label}</ItemTitle><ItemDescription>{l.description}</ItemDescription></ItemContent>
                <ItemActions><ChevronRight className="size-4 text-muted-foreground" /></ItemActions>
              </Link>
            </Item>
          ))}
          {inShell() ? (
            <Item asChild className="rounded-none border-0">
              <button onClick={() => window.devdashShell!.switchSpace()}>
                <ItemMedia variant="icon"><ArrowLeftRight /></ItemMedia>
                <ItemContent><ItemTitle>Switch space</ItemTitle><ItemDescription>Connect to a different DevDash server</ItemDescription></ItemContent>
              </button>
            </Item>
          ) : (
            <Item asChild className="rounded-none border-0">
              <button onClick={() => openExternal(APP_DOWNLOADS)}>
                <ItemMedia variant="icon"><Download /></ItemMedia>
                <ItemContent><ItemTitle>Get the app</ItemTitle><ItemDescription>Windows, Android and iPhone</ItemDescription></ItemContent>
              </button>
            </Item>
          )}
        </ItemGroup>
        <Section title="Appearance">
          <ToggleGroup type="single" variant="outline" value={theme} onValueChange={(v) => v && setTheme(v as ThemePref)} className="w-full">
            <ToggleGroupItem value="system" className="flex-1">Device</ToggleGroupItem>
            <ToggleGroupItem value="light" className="flex-1">Light</ToggleGroupItem>
            <ToggleGroupItem value="dark" className="flex-1">Dark</ToggleGroupItem>
          </ToggleGroup>
        </Section>
        <Item asChild variant="outline" className="text-destructive">
          <button onClick={() => void signOut()}>
            <ItemMedia variant="icon"><LogOut /></ItemMedia>
            <ItemContent><ItemTitle>Sign out</ItemTitle></ItemContent>
          </button>
        </Item>
      </PageBody>
    </>
  )
}
