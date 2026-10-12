import { createContext, memo, useContext, type ComponentProps, type MouseEvent, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { openExternal } from '@/lib/shell'
import { useFileLinks } from '../files/open-file'
import { codeFile, folderOf, hrefFile, type FileRef } from './file-links'

/** Claude's markdown, with links opening outside DevDash; under a FileViewerProvider, file paths open in the viewer. */
export const Prose = memo(function Prose({ text }: { text: string }) {
  return (
    <div className="prose-dd text-[15px] md:text-sm">
      <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>{text}</Markdown>
    </div>
  )
})

/** Code inside a code block is never a file link, only inline code. */
const InBlock = createContext(false)

/** A file link: a real link to its folder in Files (so it can open in a new tab), a tap opens the viewer. */
function FileAnchor({ f, className, children }: { f: FileRef; className?: string; children: ReactNode }) {
  const files = useFileLinks()!
  return (
    <a href={`/files?${new URLSearchParams({ path: folderOf(f.path) })}`} title={f.line ? `${f.path}, line ${f.line}` : f.path} className={className}
      onClick={(e: MouseEvent) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); files.open(f.path, f.line) }}>{children}</a>
  )
}

const COMPONENTS: Components = {
  a: function ProseLink({ href, children }) {
    const files = useFileLinks()
    const f = files && href ? hrefFile(href, files) : null
    if (f) return <FileAnchor f={f}>{children}</FileAnchor>
    return <a href={href} onClick={(e) => { e.preventDefault(); if (href) openExternal(href) }}>{children}</a>
  },
  pre: function ProsePre({ node: _, ...props }: ComponentProps<'pre'> & { node?: unknown }) {
    return <InBlock.Provider value><pre {...props} /></InBlock.Provider>
  },
  code: function ProseCode({ node: _, children, ...props }) {
    const files = useFileLinks()
    const block = useContext(InBlock)
    const f = files && !block && typeof children === 'string' ? codeFile(children, files) : null
    if (f) return <FileAnchor f={f} className="file-code"><code {...props}>{children}</code></FileAnchor>
    return <code {...props}>{children}</code>
  },
}
