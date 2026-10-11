import { queryOptions, useQueryClient } from '@tanstack/react-query'
import type { InferResponseType } from 'hono/client'
import { api, unwrap } from '@/lib/api'
import { useTopic } from '@/lib/live'

export const teamQuery = (slug: string) => queryOptions({
  queryKey: ['team', 'project', slug],
  queryFn: () => unwrap(api.api.team.projects[':slug'].$get({ param: { slug } })),
})
export const roleQuery = (id: number) => queryOptions({
  queryKey: ['team', 'role', id],
  queryFn: () => unwrap(api.api.team.roles[':id'].$get({ param: { id: String(id) } })),
})

export type Team = InferResponseType<typeof api.api.team.projects[':slug']['$get']>
export type Role = Team['roles'][number]
export type RoleDetail = InferResponseType<typeof api.api.team.roles[':id']['$get']>
export type Model = 'opus' | 'sonnet' | 'haiku'

/** Team pages stay current: anything a role or a person changes refreshes them. */
export function useLiveTeam() {
  const qc = useQueryClient()
  useTopic('team', () => void qc.invalidateQueries({ queryKey: ['team'] }), () => void qc.invalidateQueries({ queryKey: ['team'] }))
}

/** Starting points for a new role: a name and a line; Generate writes the rest. */
export const TEMPLATES: { name: string; summary: string }[] = [
  { name: 'CEO', summary: 'Leads the team: decides what matters most, whether to ship, and sends the weekly summary.' },
  { name: 'CTO', summary: 'Code health, risks and releases: how close we are to shipping and what could break.' },
  { name: 'Product', summary: 'What users need next: turns feedback and data into a short, ordered list of work.' },
  { name: 'Marketing – Social', summary: 'Watches our socials and competitors, and says what to post and when.' },
  { name: 'Growth – Store listing', summary: 'App store page, screenshots, reviews and ratings, and what brings people in.' },
  { name: 'Support', summary: 'Reads what users report, finds the patterns, and turns them into tasks.' },
  { name: 'QA', summary: 'Checks what changed for bugs and gaps before each release.' },
  { name: 'Finance', summary: 'Spending, revenue and costs: where money goes and what to cut or invest in.' },
]

const TONES = [
  'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  'bg-teal-500/15 text-teal-700 dark:text-teal-300',
]
/** Each role keeps its own color. */
export const roleTone = (id: number) => TONES[id % TONES.length]!
/** "Marketing – Social" → "MS", "CTO" → "CTO". */
export const roleMark = (name: string) => {
  const words = name.split(/[\s–-]+/).filter((w) => /\w/.test(w))
  if (words.length === 1 && words[0]!.length <= 4) return words[0]!.toUpperCase()
  return words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join('')
}
export const firstLine = (s: string | null | undefined) => (s ?? '').replace(/[#*_`>]/g, '').split('\n').map((l) => l.trim()).find(Boolean) ?? ''
