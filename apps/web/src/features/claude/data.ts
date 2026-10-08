import { queryOptions, useQueryClient } from '@tanstack/react-query'
import type { InferResponseType } from 'hono/client'
import { api, unwrap } from '../../lib/api'
import { useTopic } from '../../lib/live'

export type Session = InferResponseType<typeof api.api.claude.sessions.$get>['sessions'][number]
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type PendingRequest = { requestId: string; toolName: string; input: Record<string, unknown>; suggestions?: unknown[] }

export const sessionsQuery = (archived = false) => queryOptions({
  queryKey: ['claude', 'sessions', archived],
  queryFn: () => unwrap(api.api.claude.sessions.$get({ query: { archived: archived ? '1' : '0' } })),
})
export const sessionQuery = (id: string) => queryOptions({
  queryKey: ['claude', 'session', id],
  queryFn: () => unwrap(api.api.claude.sessions[':id'].$get({ param: { id } })),
})
export const profilesQuery = queryOptions({
  queryKey: ['claude', 'profiles'],
  queryFn: () => unwrap(api.api.claude.profiles.$get()),
  staleTime: 30_000,
})
export const commandsQuery = (profile: string) => queryOptions({
  queryKey: ['claude', 'commands', profile],
  queryFn: () => unwrap(api.api.claude.commands.$get({ query: { profile } })),
  staleTime: 60_000,
})

/** Keeps the cached session list in step with live status changes. */
export function useLiveSessions() {
  const qc = useQueryClient()
  useTopic('sessions', (e) => {
    if (e.type !== 'session') return
    const s = e.session as Session
    qc.setQueryData(sessionsQuery(false).queryKey, (old) => {
      if (!old) return old
      const rest = old.sessions.filter((x) => x.id !== s.id)
      return { sessions: s.archived ? rest : [s, ...rest].sort((a, b) => b.lastActivityAt - a.lastActivityAt) }
    })
  }, () => void qc.invalidateQueries({ queryKey: ['claude', 'sessions'] }))
}

export const STATUS_LABEL: Record<Session['status'], string> = {
  working: 'Working', waiting: 'Needs you', idle: 'Idle', stopped: 'Stopped', error: 'Error',
}

export const PERMISSION_MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'bypassPermissions', label: 'Bypass', hint: 'Runs everything without asking' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'Edits files freely, asks before commands' },
  { value: 'plan', label: 'Plan', hint: 'Reads and plans, changes nothing until you approve' },
  { value: 'default', label: 'Ask', hint: 'Asks before each change' },
  { value: 'auto', label: 'Auto', hint: 'A classifier decides, asks when unsure' },
]
export const modeLabel = (m: string) => PERMISSION_MODES.find((p) => p.value === m)?.label ?? m

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const FALLBACK_MODELS: { value: string; displayName: string; description?: string }[] = [
  { value: '', displayName: 'Default' },
  { value: 'opus', displayName: 'Opus' },
  { value: 'sonnet', displayName: 'Sonnet' },
  { value: 'haiku', displayName: 'Haiku' },
]

export const relativeTime = (unix: number) => {
  const s = Math.max(0, Date.now() / 1000 - unix)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  return new Date(unix * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const URGENCY: Record<string, number> = { waiting: 0, working: 1, error: 2, idle: 3, stopped: 3 }

/** Sessions grouped by folder: folders with something waiting first, then by most recent activity. */
export function byFolder(sessions: Session[]) {
  const groups = new Map<string, Session[]>()
  for (const s of sessions) {
    const g = groups.get(s.cwd)
    if (g) g.push(s)
    else groups.set(s.cwd, [s])
  }
  return [...groups.entries()]
    .map(([cwd, list]) => ({
      cwd,
      owner: list[0]!.owner.username,
      sessions: list.sort((a, b) => URGENCY[a.status]! - URGENCY[b.status]! || b.lastActivityAt - a.lastActivityAt),
      waiting: list.filter((s) => s.status === 'waiting').length,
      latest: Math.max(...list.map((s) => s.lastActivityAt)),
    }))
    .sort((a, b) => Number(b.waiting > 0) - Number(a.waiting > 0) || b.latest - a.latest)
}

/** "~/projects/app" for paths in the member's home. */
export const shortPath = (cwd: string, username: string) => cwd.replace(new RegExp(`^/home/${username}(?=/|$)`), '~')
