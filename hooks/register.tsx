import type { EngineInterface, Register } from 'claude-code'

import {
  dvipngColor,
  hashKey,
  hasMath,
  inlineToUnicode,
  isSafeTex,
  latexError,
  pngSize,
  segmentsToUnicode,
  splitMath,
  texDocument,
  texToUnicode,
} from './latex'
import type { Segment } from './latex'

// Pixels per terminal row the formulas are typeset at; the terminal scales
// the picture to its cells, so this only sets how crisp they are.
const ROW_PX = 40
const VERSION = 1

type Display = Segment & { kind: 'display' }
type Typeset = { path: string; width: number; height: number }
type Picture = { path: string; columns: number; rows: number }

type Settings = {
  images: string
  color: string
  scale: number
  cellAspect: number
  preamble: string
}

// What the module learns once per load: its options, whether pictures can be
// drawn, the cache folder, the ink color, and every formula typeset so far.
let settings: Settings = { images: 'auto', color: 'auto', scale: 1.25, cellAspect: 2.1, preamble: '' }
let canDraw: Promise<boolean> | undefined
let cacheDir: Promise<string> | undefined
let ink: Promise<string> | undefined
const typeset = new Map<string, Promise<Typeset | undefined>>()
const fitted = new Map<string, Promise<Picture | undefined>>()

export const register: Register = (on, options) => {
  settings = {
    images: String(options.images ?? 'auto'),
    color: String(options.color ?? 'auto'),
    scale: clamp(Number(options.scale) || 1.25, 0.5, 4),
    cellAspect: clamp(Number(options.cellAspect) || 2.1, 1, 4),
    preamble: String(options.preamble ?? ''),
  }

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = e.props.text
    if (e.props.isSummary || !hasMath(text)) return next(e)

    const segments = splitMath(text)
    const hasDisplay = segments.some(s => s.kind === 'display')
    const drawsPictures = e.surface === 'terminal' && hasDisplay && (await imagesOn($))

    if (!drawsPictures) {
      const rewritten = segmentsToUnicode(segments)
      return rewritten === text ? next(e) : next({ ...e, props: { ...e.props, text: rewritten } })
    }

    const room = Math.max(10, (e.viewport?.columns ?? 80) - 4)
    const pictures = await Promise.all(
      segments.map(s => (s.kind === 'display' ? fit($, s, room) : Promise.resolve(undefined))),
    )

    const { Box, Text, Markdown, Image } = $.ui.resolve(e)
    const children: JSX.Element[] = []
    let pendingText = ''
    const flushText = () => {
      const md = pendingText.replace(/^\s*\n/, '').replace(/\n\s*$/, '')
      if (md.trim() !== '') children.push(<Markdown text={inlineToUnicode(md)} />)
      pendingText = ''
    }

    segments.forEach((s, index) => {
      const picture = pictures[index]
      if (s.kind === 'markdown') {
        pendingText += s.text
      } else if (!picture) {
        pendingText += segmentsToUnicode([s])
      } else {
        flushText()
        children.push(
          <Box marginLeft={2}>
            <Image
              key={`math-${index}`}
              source={{ file: picture.path, format: 'png' }}
              columns={picture.columns}
              rows={picture.rows}
              alt={texToUnicode(s.tex) || ' '}
            />
          </Box>,
        )
      }
    })
    flushText()

    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text>{e.props.isFirstOfReply ? '●' : ' '}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {children}
        </Box>
      </Box>
    )
  })
}

function imagesOn($: EngineInterface): Promise<boolean> {
  canDraw ??= detectImages($, settings.images)
  return canDraw
}

async function detectImages($: EngineInterface, option: string): Promise<boolean> {
  if (option === 'off') return false
  const tools = await Promise.all([
    $.process.run(['latex', '--version']).then(r => r.exitCode === 0, () => false),
    $.process.run(['dvipng', '--version']).then(r => r.exitCode === 0, () => false),
  ])
  if (!tools.every(Boolean)) return false
  if (option === 'on') return true

  const [term, program, kitty, tmux, ssh] = await Promise.all([
    $.env.get('TERM'),
    $.env.get('TERM_PROGRAM'),
    $.env.get('KITTY_WINDOW_ID'),
    $.env.get('TMUX'),
    $.env.get('SSH_CONNECTION'),
  ])
  // The terminal reads the picture from this machine's files over the kitty
  // graphics protocol, which tmux does not pass and ssh cannot reach.
  if (tmux || ssh) return false
  const name = `${term ?? ''} ${program ?? ''}`.toLowerCase()
  return Boolean(kitty) || /kitty|ghostty|wezterm/.test(name)
}

function cache($: EngineInterface): Promise<string> {
  cacheDir ??= findCacheDir($)
  return cacheDir
}

async function findCacheDir($: EngineInterface): Promise<string> {
  const [xdg, home] = await Promise.all([$.env.get('XDG_CACHE_HOME'), $.env.get('HOME')])
  return `${xdg || `${home ?? '/tmp'}/.cache`}/claude-latex-render`
}

function color($: EngineInterface): Promise<string> {
  ink ??= pickColor($, settings.color)
  return ink
}

async function pickColor($: EngineInterface, option: string): Promise<string> {
  const chosen = option !== 'auto' ? dvipngColor(option) : undefined
  if (chosen) return chosen
  const rows = await $.config.list().catch(() => [])
  const theme = String(rows.find(row => row.key === 'theme')?.value ?? 'dark')
  return dvipngColor(theme.includes('light') ? '#1f1f1f' : '#e6e6e6') ?? 'rgb 0.9 0.9 0.9'
}

// Typesets one formula to a tight transparent PNG, cached on disk by content.
function typesetFormula($: EngineInterface, segment: Display): Promise<Typeset | undefined> {
  const id = `${segment.env}\u0000${segment.tex}`
  let pending = typeset.get(id)
  if (!pending) {
    pending = runLatex($, segment).catch(() => undefined)
    typeset.set(id, pending)
  }
  return pending
}

async function runLatex($: EngineInterface, segment: Display): Promise<Typeset | undefined> {
  if (!isSafeTex(segment.tex)) return undefined
  const dir = await cache($)
  const fg = await color($)
  const doc = texDocument(segment, settings.preamble)
  const dpi = Math.round((settings.scale * ROW_PX * 72.27) / 12)
  const key = hashKey([VERSION, doc, fg, dpi].join('\u0000'))
  const png = `${dir}/${key}.png`
  const failed = `${dir}/${key}.err`

  if (await $.fs.exists(failed)) return undefined
  if (!(await $.fs.exists(png))) {
    await $.fs.write(`${dir}/${key}.tex`, doc)
    const latex = await $.process.run(
      ['latex', '-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', `${key}.tex`],
      { cwd: dir, env: { openout_any: 'p', openin_any: 'p' }, timeoutMs: 15000 },
    )
    if (latex.exitCode !== 0) {
      await $.fs.write(failed, latexError(latex.stdout))
      return undefined
    }
    const dvipng = await $.process.run(
      ['dvipng', '-q', '-D', String(dpi), '-T', 'tight', '-bg', 'Transparent', '-fg', fg, '-o', `${key}.png`, `${key}.dvi`],
      { cwd: dir, timeoutMs: 15000 },
    )
    await $.process.run(['rm', '-f', `${key}.aux`, `${key}.log`, `${key}.dvi`], { cwd: dir }).catch(() => undefined)
    if (dvipng.exitCode !== 0) {
      await $.fs.write(failed, dvipng.stderr || 'dvipng failed')
      return undefined
    }
  }

  const { base64 } = await $.fs.read(png, { as: 'bytes' })
  const size = pngSize(base64)
  return size ? { path: png, ...size } : undefined
}

// Pads (and if needed shrinks) a typeset formula to a whole number of cells,
// so the terminal's scaling to the box keeps its proportions.
function fit($: EngineInterface, segment: Display, room: number): Promise<Picture | undefined> {
  const id = `${segment.env}\u0000${segment.tex}\u0000${room}`
  let pending = fitted.get(id)
  if (!pending) {
    pending = padToCells($, segment, room).catch(() => undefined)
    fitted.set(id, pending)
  }
  return pending
}

async function padToCells($: EngineInterface, segment: Display, room: number): Promise<Picture | undefined> {
  const base = await typesetFormula($, segment)
  if (!base) return undefined
  const cellW = ROW_PX / settings.cellAspect
  const shrink = Math.min(1, (room * cellW) / base.width)
  const width = Math.max(1, Math.round(base.width * shrink))
  const height = Math.max(1, Math.round(base.height * shrink))
  const columns = clamp(Math.ceil(width / cellW), 1, 255)
  const rows = clamp(Math.ceil(height / ROW_PX), 1, 255)
  const out = base.path.replace(/\.png$/, `-${columns}x${rows}.png`)

  if (!(await $.fs.exists(out))) {
    const args = ['magick', base.path]
    if (shrink < 1) args.push('-resize', `${width}x${height}!`)
    args.push('-background', 'none', '-gravity', 'west', '-extent', `${Math.round(columns * cellW)}x${rows * ROW_PX}`, out)
    const padded = await $.process.run(args, { timeoutMs: 15000 }).catch(() => undefined)
    // Without ImageMagick the picture is drawn unpadded, a little stretched.
    if (padded?.exitCode !== 0) return { path: base.path, columns, rows }
  }
  return { path: out, columns, rows }
}

function clamp(n: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, n))
}
