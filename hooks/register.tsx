import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Mode, Previewed } from '../types'

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
  settledLength,
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
// The most rows the preview above the prompt takes.
const PREVIEW_ROWS = 12

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
  preview: boolean
}

// What the module learns once per load: its options, whether pictures can be
// drawn, the cache folder, the colors, and every formula and figure typeset so far.
let settings: Settings = { images: 'auto', color: 'auto', scale: 1.25, cellAspect: 2.1, preamble: '', background: 'auto', preview: true }
let canDraw: Promise<boolean> | undefined
let canDrawFigures: Promise<boolean> | undefined
let cacheDir: Promise<string> | undefined
let colors: Promise<Palette> | undefined
// `/latex` flips this; in `source` every reply is drawn as written.
const mode = atom({ plugin: 'latex-render', key: 'mode' } as const, 'render' as Mode)
// The formulas and figures of the block being streamed, shown above the prompt until it ends.
const preview = atom({ plugin: 'latex-render', key: 'preview' } as const, [] as Previewed[])
// Counts the blocks the preview has been cleared for, so a picture typeset late is not shown under the next.
let previewed = 0
const typeset = new Map<string, Promise<Typeset | undefined>>()
const fitted = new Map<string, Promise<Picture | undefined>>()
// The width the last reply was drawn at, so a formula is fitted to it while still streaming.
let lastRoom: number | undefined

export const register: Register = (on, options) => {
  settings = {
    images: String(options.images ?? 'auto'),
    color: String(options.color ?? 'auto'),
    scale: clamp(Number(options.scale) || 1.25, 0.5, 4),
    cellAspect: clamp(Number(options.cellAspect) || 2.1, 1, 4),
    preamble: String(options.preamble ?? ''),
    background: String(options.background ?? 'auto'),
    preview: String(options.preview ?? 'on') !== 'off',
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

  // While a reply streams, each display formula and figure is typeset as
  // soon as it closes and shown above the prompt, its picture then ready, or
  // nearly, when the block ends and is drawn. The chunks pass on unchanged.
  on('turn.step', async function* ($, e, next) {
    const onTerminal = e.agentId === undefined && (await $.session.surfaces()).includes('terminal')
    if (!onTerminal || (await read($, mode)) === 'source' || !(await imagesOn($))) return yield* next(e)
    let block: number | undefined // the index of the text block being written
    let text = '' // its text so far
    let settled = 0 // how much of it has been handed to the typesetter
    let isShowing = false // the preview may hold this block's pictures
    // The block's row is drawn when it ends, so its preview goes.
    const endPreview = () => {
      if (!isShowing) return
      isShowing = false
      previewed += 1
      void update($, preview, () => []).catch(() => undefined)
    }

    try {
      for await (const chunk of next(e)) {
        yield chunk
        if (chunk.kind !== 'text') {
          endPreview()
          continue
        }
        if (chunk.index !== block) {
          endPreview()
          block = chunk.index
          text = ''
          settled = 0
        }
        text += chunk.text
        const upTo = settledLength(text)
        if (upTo > settled) {
          const piece = text.slice(settled, upTo)
          void prepare($, piece)
          if (settings.preview) {
            isShowing = true
            void showPreview($, piece, previewed)
          }
          settled = upTo
        }
      }
    } finally {
      endPreview()
    }
  })

  // Above the prompt, while Claude writes: the newest formulas and figures of
  // the block it is writing, as many as the band has rows for.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Both read first, so the band is drawn again when either changes.
    const [items, current] = await Promise.all([read($, preview), read($, mode)])
    const { hasSurvey, isWorking, maxRows, bodyColumns, view } = e.props
    // A strip, not a page: outside fullscreen `maxRows` is the terminal's height. A row goes to the heading.
    const budget = Math.min(maxRows, PREVIEW_ROWS) - 1
    const isQuiet = items.length === 0 || current === 'source' || hasSurvey || !isWorking || view.agentId !== undefined
    if (isQuiet || e.surface !== 'terminal' || budget < 1) return next(e)

    const room = Math.max(10, bodyColumns - 2)
    const pictures = await Promise.all(items.map(item => fit($, item, room, budget)))
    const shown: { item: Previewed; picture: Picture; index: number }[] = []
    let left = budget
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index]
      const picture = pictures[index]
      if (!item || !picture) continue
      if (picture.rows > left) break
      shown.unshift({ item, picture, index })
      left -= picture.rows
    }
    if (shown.length === 0) return next(e)

    const { Box, Text, Image } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text dimColor>LaTeX preview</Text>
        {shown.map(({ item, picture, index }) => (
          <Box marginLeft={2}>
            <Image
              key={`preview-${index}`}
              source={{ file: picture.path, format: 'png' }}
              columns={picture.columns}
              rows={picture.rows}
              alt={item.kind === 'figure' ? 'TikZ figure' : texToUnicode(item.tex) || ' '}
            />
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // Read before anything else, so every reply is drawn again when it changes.
    if ((await read($, mode)) === 'source') return next(e)
    const text = e.props.text
    if (!hasMath(text)) return next(e)

    const segments = splitMath(text)
    const hasDisplay = segments.some(s => s.kind !== 'markdown')
    // A summary row stays one line of text: its math in Unicode, never a picture.
    const drawsPictures = !e.props.isSummary && e.surface === 'terminal' && hasDisplay && (await imagesOn($))

    if (!drawsPictures) {
      const rewritten = segmentsToUnicode(segments)
      return rewritten === text ? next(e) : next({ ...e, props: { ...e.props, text: rewritten } })
    }

    const room = Math.max(10, (e.viewport?.columns ?? 80) - 4)
    lastRoom = room
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

function drawnIn(text: string): Drawn[] {
  return splitMath(text).filter((s): s is Drawn => s.kind !== 'markdown')
}

// Typesets the formulas and figures in a piece of a reply ahead of its drawing.
function prepare($: EngineInterface, text: string): Promise<unknown> {
  return Promise.all(drawnIn(text).map(s => (lastRoom === undefined ? typesetSegment($, s) : fit($, s, lastRoom))))
}

// Adds each formula and figure in a piece of a reply to the preview once it is
// typeset, in order, unless the block it belongs to has ended by then.
async function showPreview($: EngineInterface, text: string, block: number): Promise<void> {
  for (const segment of drawnIn(text)) {
    const done = await typesetSegment($, segment)
    if (!done || block !== previewed) continue
    const item: Previewed =
      segment.kind === 'figure'
        ? { kind: 'figure', tex: segment.tex }
        : segment.env
          ? { kind: 'display', tex: segment.tex, env: segment.env }
          : { kind: 'display', tex: segment.tex }
    await update($, preview, items => [...items, item].slice(-8)).catch(() => undefined)
  }
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
  const doc = texDocument(segment, settings.preamble, ink, paper)
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
// Within `room` columns and, when given, `rowLimit` rows.
function fit($: EngineInterface, segment: Drawn, room: number, rowLimit?: number): Promise<Picture | undefined> {
  const id = `${segment.kind === 'figure' ? 'figure' : segment.env}\u0000${segment.tex}\u0000${room}\u0000${rowLimit ?? ''}`
  let pending = fitted.get(id)
  if (!pending) {
    pending = padToCells($, segment, room, rowLimit).catch(() => undefined)
    fitted.set(id, pending)
  }
  return pending
}

async function padToCells($: EngineInterface, segment: Drawn, room: number, rowLimit?: number): Promise<Picture | undefined> {
  const base = await typesetSegment($, segment)
  if (!base) return undefined
  const cellW = ROW_PX / settings.cellAspect
  const tall = rowLimit === undefined ? 1 : (rowLimit * ROW_PX) / base.height
  const shrink = Math.min(1, (room * cellW) / base.width, tall)
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
