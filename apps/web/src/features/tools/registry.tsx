import {
  ArrowRightLeft, Binary, Braces, CalendarClock, CaseSensitive, Clock, Code, Diff, FileJson, Fingerprint,
  Globe, Hash, KeyRound, Link, ListOrdered, Palette, QrCode, Regex, Scissors, Server, Shield, Type,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { Base64Tool, CaseTool, ColorTool, HtmlEntityTool, JsonFormatter, JsonYaml, NumberBaseTool, TimestampTool, UrlTool } from './tools-convert'
import { HashTool, LoremTool, PasswordTool, QrTool, UuidTool } from './tools-generate'
import { JwtDecoder, LineTools, RegexTester, Slugify, TextDiff } from './tools-text'
import { CronTool, HttpStatusTool, JsonQueryTool } from './tools-web'

export type ToolCategory = 'Convert' | 'Generate' | 'Text' | 'Web'

export type Tool = {
  id: string
  name: string
  description: string
  keywords: string[]
  category: ToolCategory
  icon: typeof Braces
  Component: ComponentType
}

export const CATEGORIES: ToolCategory[] = ['Convert', 'Generate', 'Text', 'Web']

export const TOOLS: Tool[] = [
  // ----- Convert -----
  { id: 'json', name: 'JSON formatter', description: 'Pretty-print, minify and validate JSON with line-pointed errors.', keywords: ['beautify', 'format', 'validate', 'prettify', 'lint'], category: 'Convert', icon: Braces, Component: JsonFormatter },
  { id: 'json-yaml', name: 'JSON ⇄ YAML', description: 'Convert between JSON and YAML in either direction.', keywords: ['yaml', 'yml', 'json', 'config'], category: 'Convert', icon: FileJson, Component: JsonYaml },
  { id: 'base64', name: 'Base64', description: 'Encode or decode Base64 text, URL-safe variant, or drop a file.', keywords: ['base64', 'encode', 'decode', 'btoa', 'atob', 'file'], category: 'Convert', icon: Binary, Component: Base64Tool },
  { id: 'url', name: 'URL encode', description: 'Percent-encode or decode URL components.', keywords: ['url', 'uri', 'percent', 'encode', 'decode', 'escape'], category: 'Convert', icon: Link, Component: UrlTool },
  { id: 'html-entities', name: 'HTML entities', description: 'Escape or unescape HTML entities like &amp; and &lt;.', keywords: ['html', 'entities', 'escape', 'unescape', 'amp'], category: 'Convert', icon: Code, Component: HtmlEntityTool },
  { id: 'timestamp', name: 'Unix time', description: 'Convert between Unix timestamps and human dates, with relative time.', keywords: ['unix', 'epoch', 'timestamp', 'date', 'time', 'iso'], category: 'Convert', icon: Clock, Component: TimestampTool },
  { id: 'number-base', name: 'Number base', description: 'Convert between decimal, hex, binary and octal (big integers).', keywords: ['base', 'hex', 'binary', 'octal', 'decimal', 'radix', 'convert'], category: 'Convert', icon: Hash, Component: NumberBaseTool },
  { id: 'case', name: 'Case converter', description: 'camelCase, snake_case, kebab-case, Title Case and more.', keywords: ['case', 'camel', 'snake', 'kebab', 'pascal', 'title', 'upper', 'lower'], category: 'Convert', icon: CaseSensitive, Component: CaseTool },
  { id: 'color', name: 'Colour converter', description: 'Convert hex, rgb and hsl with a live preview and picker.', keywords: ['color', 'colour', 'hex', 'rgb', 'hsl', 'picker'], category: 'Convert', icon: Palette, Component: ColorTool },

  // ----- Generate -----
  { id: 'uuid', name: 'UUID v4', description: 'Generate random UUIDs, one or in bulk.', keywords: ['uuid', 'guid', 'id', 'random', 'v4'], category: 'Generate', icon: Fingerprint, Component: UuidTool },
  { id: 'hash', name: 'Hash', description: 'MD5, SHA-1, SHA-256 and SHA-512 digests of text.', keywords: ['hash', 'md5', 'sha', 'sha256', 'sha512', 'digest', 'checksum'], category: 'Generate', icon: Shield, Component: HashTool },
  { id: 'password', name: 'Password', description: 'Strong random passwords with length and charset controls.', keywords: ['password', 'random', 'secret', 'generate', 'string', 'token'], category: 'Generate', icon: KeyRound, Component: PasswordTool },
  { id: 'lorem', name: 'Lorem ipsum', description: 'Placeholder words, sentences or paragraphs.', keywords: ['lorem', 'ipsum', 'placeholder', 'dummy', 'text'], category: 'Generate', icon: Type, Component: LoremTool },
  { id: 'qr', name: 'QR code', description: 'Turn any text or URL into a downloadable QR code.', keywords: ['qr', 'qrcode', 'barcode', 'url', 'png'], category: 'Generate', icon: QrCode, Component: QrTool },

  // ----- Text -----
  { id: 'diff', name: 'Text diff', description: 'Compare two blocks of text with added/removed lines highlighted.', keywords: ['diff', 'compare', 'difference', 'merge', 'change'], category: 'Text', icon: Diff, Component: TextDiff },
  { id: 'regex', name: 'Regex tester', description: 'Test a regular expression with live matches and capture groups.', keywords: ['regex', 'regexp', 'pattern', 'match', 'test'], category: 'Text', icon: Regex, Component: RegexTester },
  { id: 'jwt', name: 'JWT decoder', description: 'Decode a JWT header and payload and check expiry (no verify).', keywords: ['jwt', 'token', 'jws', 'decode', 'claims', 'auth'], category: 'Text', icon: Shield, Component: JwtDecoder },
  { id: 'lines', name: 'Sort & dedup lines', description: 'Sort, deduplicate, trim and count lines of text.', keywords: ['sort', 'dedup', 'unique', 'lines', 'trim', 'count'], category: 'Text', icon: ListOrdered, Component: LineTools },
  { id: 'slugify', name: 'Slugify', description: 'Turn any text into a clean URL slug.', keywords: ['slug', 'slugify', 'url', 'permalink', 'kebab'], category: 'Text', icon: Scissors, Component: Slugify },

  // ----- Web -----
  { id: 'cron', name: 'Cron explainer', description: 'Explain a cron expression in plain English and preview next runs.', keywords: ['cron', 'crontab', 'schedule', 'job', 'expression'], category: 'Web', icon: CalendarClock, Component: CronTool },
  { id: 'http-status', name: 'HTTP status codes', description: 'Look up any HTTP status code and what it means.', keywords: ['http', 'status', 'code', '404', '500', 'response'], category: 'Web', icon: Server, Component: HttpStatusTool },
  { id: 'json-query', name: 'JSON ⇄ query string', description: 'Convert between a URL query string and a JSON object.', keywords: ['query', 'querystring', 'json', 'url', 'params', 'search'], category: 'Web', icon: Globe, Component: JsonQueryTool },
]

export const TOOLS_BY_ID: Record<string, Tool> = Object.fromEntries(TOOLS.map((t) => [t.id, t]))

export const CATEGORY_ICON: Record<ToolCategory, typeof Braces> = {
  Convert: ArrowRightLeft, Generate: Fingerprint, Text: Type, Web: Globe,
}
