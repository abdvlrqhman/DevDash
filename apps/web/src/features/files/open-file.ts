import { createContext, useContext } from 'react'
import type { Where } from '../claude/file-links'

/**
 * Where file paths in text are read from (a session's folder and owner) and how to open one. Set by FileViewerProvider;
 * without it (notes, tasks) paths stay plain text and links go out as before.
 */
export type FileLinks = Where & { open: (path: string, line?: number) => void }
export const FileLinksContext = createContext<FileLinks | null>(null)
export const useFileLinks = () => useContext(FileLinksContext)
