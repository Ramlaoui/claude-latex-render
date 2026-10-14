import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Mode } from '../types'

import {
  dvipngColor,
  figureDocument,
  hashKey,
  hasMath,
  inlineToUnicode,
  isSafeTex,
  latexError,
  nextMode,
  pngSize,
  segmentsToUnicode,
  splitMath,
  styleGuide,
  texDocument,
  texToUnicode,
} from './latex'
import type { Segment } from './latex'

// Pixels per terminal row the formulas are typeset at; the terminal scales
// the picture to its cells, so this only sets how crisp they are.
const ROW_PX = 40
const VERSION = 1

type Display = Segment & { kind: 'display' }
type Figure = Segment & { kind: 'figure' }
type Drawn = Display | Figure
type Palette = { ink: string; paper?: string }
type Typeset = { path: string; width: number; height: number }
type Picture = { path: string; columns: number; rows: number }

type Settings = {
  images: string
  color: string
  scale: number
  cellAspect: number
  preamble: string
  background: string
}

// What the module learns once per load: its options, whether pictures can be
// drawn, the cache folder, the colors, and every formula and figure typeset so far.
let settings: Settings = { images: 'auto', color: 'auto', scale: 1.25, cellAspect: 2.1, preamble: '', background: 'auto' }
let canDraw: Promise<boolean> | undefined
let canDrawFigures: Promise<boolean> | undefined
let cacheDir: Promise<string> | undefined
let colors: Promise<Palette> | undefined
// `/latex` flips this; in `source` every reply is drawn as written.
const mode = atom({ plugin: 'latex-render', key: 'mode' } as const, 'render' as Mode)
const typeset = new Map<string, Promise<Typeset | undefined>>()
const fitted = new Map<string, Promise<Picture | undefined>>()

export const register: Register = (on, options) => {
  settings = {
    images: String(options.images ?? 'auto'),
    color: String(options.color ?? 'auto'),
    scale: clamp(Number(options.scale) || 1.25, 0.5, 4),
    cellAspect: clamp(Number(options.cellAspect) || 2.1, 1, 4),
    preamble: String(options.preamble ?? ''),
    background: String(options.background ?? 'auto'),
  }
  // What was found for the previous options no longer holds.
  canDraw = canDrawFigures = colors = undefined

  // Tells the model how to write math and figures so they are drawn well here.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.surfaces.includes('terminal')) return composed
    const [pictures, figures, { paper }] = await Promise.all([imagesOn($), figuresOn($), palette($)])
    const section = { id: 'latex-render:style', text: styleGuide({ pictures, figures, paper }), scope: 'session' } as const
    return { sections: [...composed.sections, section] }
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'latex',
      description: 'Toggle LaTeX in replies between rendered and as written',
      argumentHint: '[render|source]',
      immediate: true,
    })
    // A reload keeps the mode; the status line has to say so again.
    showMode($, await read($, mode))
    return next(e)
  })

  on('command.run', { command: 'latex' }, async ($, e) => {
    const chosen = nextMode(await read($, mode), e.args)
    if (!chosen) return { text: 'Usage: /latex [render|source]' }
    await update($, mode, () => chosen)
    showMode($, chosen)
    return { text: chosen === 'source' ? 'LaTeX is shown as written.' : 'LaTeX is rendered.' }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // Read before anything else, so every reply is drawn again when it changes.
    if ((await read($, mode)) === 'source') return next(e)
    const text = e.props.text
    if (e.props.isSummary || !hasMath(text)) return next(e)

    const segments = splitMath(text)
    const hasDisplay = segments.some(s => s.kind !== 'markdown')
    const drawsPictures = e.surface === 'terminal' && hasDisplay && (await imagesOn($))

    if (!drawsPictures) {
      const rewritten = segmentsToUnicode(segments)
      return rewritten === text ? next(e) : next({ ...e, props: { ...e.props, text: rewritten } })
    }

    const room = Math.max(10, (e.viewport?.columns ?? 80) - 4)
    const pictures = await Promise.all(
      segments.map(s => (s.kind === 'markdown' ? Promise.resolve(undefined) : fit($, s, room))),
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
              key={`${s.kind === 'figure' ? 'figure' : 'math'}-${index}`}
              source={{ file: picture.path, format: 'png' }}
              columns={picture.columns}
              rows={picture.rows}
              alt={s.kind === 'figure' ? 'TikZ figure' : texToUnicode(s.tex) || ' '}
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

function showMode($: EngineInterface, current: Mode): void {
  $.ui.status(current === 'source' ? 'LaTeX: source (/latex to render)' : undefined)
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

// Figures take pdflatex and pdftocairo besides what formulas take.
function figuresOn($: EngineInterface): Promise<boolean> {
  canDrawFigures ??= imagesOn($).then(async on => {
    if (!on) return false
    const tools = await Promise.all(
      ['pdflatex', 'pdftocairo'].map(tool => $.process.run([tool, '-v']).then(r => r.exitCode === 0, () => false)),
    )
    return tools.every(Boolean)
  })
  return canDrawFigures
}

function cache($: EngineInterface): Promise<string> {
  cacheDir ??= findCacheDir($)
  return cacheDir
}

async function findCacheDir($: EngineInterface): Promise<string> {
  const [xdg, home] = await Promise.all([$.env.get('XDG_CACHE_HOME'), $.env.get('HOME')])
  return `${xdg || `${home ?? '/tmp'}/.cache`}/claude-latex-render`
}

function palette($: EngineInterface): Promise<Palette> {
  colors ??= pickPalette($)
  return colors
}

// The ink, and on a dark theme the paper figures' `white` stands for.
async function pickPalette($: EngineInterface): Promise<Palette> {
  const rows = await $.config.list().catch(() => [])
  const light = String(rows.find(row => row.key === 'theme')?.value ?? 'dark').includes('light')
  const hex = (option: string, fallback: string) => (dvipngColor(option) ? option.replace('#', '') : fallback)
  return {
    ink: hex(settings.color, light ? '1f1f1f' : 'e6e6e6'),
    paper: light ? undefined : hex(settings.background, '1e1e1e'),
  }
}

// Typesets one formula or figure to a tight transparent PNG, cached on disk by content.
function typesetSegment($: EngineInterface, segment: Drawn): Promise<Typeset | undefined> {
  const id = segment.kind === 'figure' ? `figure\u0000${segment.tex}` : `${segment.env}\u0000${segment.tex}`
  let pending = typeset.get(id)
  if (!pending) {
    pending = (segment.kind === 'figure' ? runTikz($, segment) : runLatex($, segment)).catch(() => undefined)
    typeset.set(id, pending)
  }
  return pending
}

async function runLatex($: EngineInterface, segment: Display): Promise<Typeset | undefined> {
  if (!isSafeTex(segment.tex)) return undefined
  const dir = await cache($)
  const { ink, paper } = await palette($)
  const fg = dvipngColor(ink) ?? 'rgb 0.9 0.9 0.9'
  const doc = texDocument(segment, settings.preamble, paper)
  const dpi = dpiFor()
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

  return measure($, png)
}

// A figure's text is typeset at the same size as a formula's.
function dpiFor(): number {
  return Math.round((settings.scale * ROW_PX * 72.27) / 12)
}

async function measure($: EngineInterface, png: string): Promise<Typeset | undefined> {
  const { base64 } = await $.fs.read(png, { as: 'bytes' })
  const size = pngSize(base64)
  return size ? { path: png, ...size } : undefined
}

async function runTikz($: EngineInterface, segment: Figure): Promise<Typeset | undefined> {
  if (!isSafeTex(segment.tex) || !(await figuresOn($))) return undefined
  const dir = await cache($)
  const { ink, paper } = await palette($)
  const doc = figureDocument(segment.tex, settings.preamble, ink, paper)
  const dpi = dpiFor()
  const key = hashKey([VERSION, doc, dpi].join('\u0000'))
  const png = `${dir}/${key}.png`
  const failed = `${dir}/${key}.err`

  if (await $.fs.exists(failed)) return undefined
  if (!(await $.fs.exists(png))) {
    await $.fs.write(`${dir}/${key}.tex`, doc)
    const latex = await $.process.run(
      ['pdflatex', '-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', `${key}.tex`],
      { cwd: dir, env: { openout_any: 'p', openin_any: 'p' }, timeoutMs: 30000 },
    )
    if (latex.exitCode !== 0) {
      await $.fs.write(failed, latexError(latex.stdout))
      return undefined
    }
    // pdftocairo names the picture itself, adding `.png` to the stem.
    const cairo = await $.process.run(
      ['pdftocairo', '-png', '-transp', '-singlefile', '-r', String(dpi), `${key}.pdf`, key],
      { cwd: dir, timeoutMs: 15000 },
    )
    await $.process.run(['rm', '-f', `${key}.aux`, `${key}.log`, `${key}.pdf`], { cwd: dir }).catch(() => undefined)
    if (cairo.exitCode !== 0) {
      await $.fs.write(failed, cairo.stderr || 'pdftocairo failed')
      return undefined
    }
  }
  return measure($, png)
}

// Pads (and if needed shrinks) a typeset formula or figure to a whole number
// of cells, so the terminal's scaling to the box keeps its proportions.
function fit($: EngineInterface, segment: Drawn, room: number): Promise<Picture | undefined> {
  const id = `${segment.kind === 'figure' ? 'figure' : segment.env}\u0000${segment.tex}\u0000${room}`
  let pending = fitted.get(id)
  if (!pending) {
    pending = padToCells($, segment, room).catch(() => undefined)
    fitted.set(id, pending)
  }
  return pending
}

async function padToCells($: EngineInterface, segment: Drawn, room: number): Promise<Picture | undefined> {
  const base = await typesetSegment($, segment)
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
