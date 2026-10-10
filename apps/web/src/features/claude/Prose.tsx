import { memo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { openExternal } from '@/lib/shell'

/** Claude's markdown, with links opening outside DevDash. */
export const Prose = memo(function Prose({ text }: { text: string }) {
  return (
    <div className="prose-dd text-[15px] md:text-sm">
      <Markdown remarkPlugins={[remarkGfm]} components={{
        a: ({ href, children }) => <a href={href} onClick={(e) => { e.preventDefault(); if (href) openExternal(href) }}>{children}</a>,
      }}>{text}</Markdown>
    </div>
  )
})
