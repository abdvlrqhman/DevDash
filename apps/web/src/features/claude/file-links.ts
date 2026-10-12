// Which links and code spans in Claude's replies are files, and where they are (pure, so it can be tested on its own).
// Conservative on purpose: `npm test` or `origin/main` stay code; `docs/PLAN.md` and `/srv/x/README.md:12` open.

export type FileRef = { path: string; line?: number }
export type Where = { cwd?: string; username?: string }

/** Extensions of files people and Claude mention. A bare name (no folder) needs one of these to count. */
const EXT = new Set(`md mdx markdown txt text rst adoc tex json jsonc json5 yaml yml toml ini cfg conf env lock log csv tsv xml html htm css scss sass less
  js mjs cjs jsx ts mts cts tsx vue svelte astro py pyi rb go rs java kt kts swift m mm c h cc cpp hpp cs fs php sh bash zsh fish ps1 bat sql graphql gql
  proto dart lua pl r scala ex exs erl hs ml clj nix tf hcl gradle properties patch diff svg png jpg jpeg gif webp ico avif bmp pdf ipynb prisma
  sqlite db service plist gitignore dockerignore editorconfig npmrc nvmrc`.split(/\s+/))
/** Files with no extension that are still clearly files. */
const NAMES = new Set(['Makefile', 'Dockerfile', 'Containerfile', 'Caddyfile', 'Procfile', 'Gemfile', 'Rakefile', 'Justfile', 'LICENSE', 'README', 'CHANGELOG', 'CLAUDE', 'AGENTS'])

/** "a/b.ts:42:7" → "a/b.ts", 42; "a/b.ts#L42" → "a/b.ts", 42. */
export function splitLine(s: string): FileRef {
  const m = /^(.+?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(s)
  return m ? { path: m[1]!, line: Number(m[2] ?? m[3]) } : { path: s }
}

/** "a/./b/../c" → "a/c"; keeps a leading slash. */
export function normalize(p: string) {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `${p.startsWith('/') ? '/' : ''}${out.join('/')}`
}

/** A path as Claude wrote it, made absolute: "~/" is the session owner's home, the rest is relative to the session's folder. */
export function resolvePath(p: string, { cwd, username }: Where) {
  if (p.startsWith('/')) return normalize(p)
  if (p === '~' || p.startsWith('~/')) return username ? normalize(`/home/${username}${p.slice(1)}`) : null
  return cwd ? normalize(`${cwd}/${p}`) : null
}

/** The last part names a file: a known extension, or a known extension-less name. With a folder in front, any extension will do. */
function looksLikeFile(p: string) {
  const name = p.replace(/\/+$/, '').split('/').pop() ?? ''
  if (NAMES.has(name) || NAMES.has(name.replace(/\.[^.]+$/, ''))) return true
  if (/^\.[a-z]+(\.[\w-]+)?$/i.test(name)) return EXT.has(name.split('.')[1]!.toLowerCase()) // .env, .env.local, .gitignore
  const ext = /\.([A-Za-z0-9_-]{1,12})$/.exec(name)?.[1]?.toLowerCase()
  if (!ext || !/[a-z]/.test(ext)) return false
  if (p.includes('/')) return true
  // On its own, `console.log` and `process.env` are code, not files.
  return EXT.has(ext) && !(ext === 'log' || ext === 'env')
}

/** An inline code span that is a file path (`docs/PLAN.md`, `src/main.tsx:42`, `/srv/x/README.md`), or null. */
export function codeFile(text: string, where: Where): FileRef | null {
  const t = text.trim()
  if (!t || t.length > 400 || !/^[\w@~.+\-/[\]]+(?::\d+(?::\d+)?)?$/.test(t) || /^-|^@|:\/\//.test(t) || t.includes('//')) return null
  const { path, line } = splitLine(t)
  if (!looksLikeFile(path)) return null
  const abs = resolvePath(path, where)
  return abs ? { path: abs, line } : null
}

/** A markdown link's target that is a file (absolute, ~/, ./, ../, file://, or a relative path to a file), or null for web links. */
export function hrefFile(href: string, where: Where): FileRef | null {
  let h = href.trim()
  if (!h || h.startsWith('#') || h.startsWith('//')) return null
  if (/^file:\/\//i.test(h)) h = h.replace(/^file:\/\/(localhost)?/i, '')
  else if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return null // http:, mailto: and the like
  try { h = decodeURIComponent(h) } catch { /* keep as written */ }
  const { path, line } = splitLine(h.replace(/[?].*$/, ''))
  const explicit = /^(\/|~\/|\.\.?\/)/.test(path)
  if (!explicit && !looksLikeFile(path)) return null
  const abs = resolvePath(path, where)
  return abs ? { path: abs, line } : null
}

/** The folder a file is in. */
export const folderOf = (p: string) => p.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/'

export type FileKind = 'markdown' | 'image' | 'pdf' | 'text'
const IMAGES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon' }

/** How the viewer shows a file, by its name. Anything not markdown, an image or a PDF is tried as text. */
export function fileKind(name: string): { kind: FileKind; mime?: string } {
  const ext = /\.([^./]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''
  if (ext === 'md' || ext === 'mdx' || ext === 'markdown') return { kind: 'markdown' }
  if (IMAGES[ext]) return { kind: 'image', mime: IMAGES[ext] }
  if (ext === 'pdf') return { kind: 'pdf', mime: 'application/pdf' }
  return { kind: 'text' }
}
