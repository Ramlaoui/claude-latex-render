# claude-latex-render

A Claude Code mod that renders LaTeX math and TikZ figures in Claude's replies, right in the terminal.

- **Display math** (`$$…$$`, `\[…\]`, `equation`, `align`, `gather`, …) is typeset with `latex` + `dvipng` and drawn as a crisp image through the kitty graphics protocol.
- **TikZ figures** (a ` ```tikz ` fenced block, or a bare `tikzpicture` or `tikzcd` environment) are compiled with `pdflatex` + `pdftocairo` and drawn the same way. A fence may hold bare commands (`\draw …;`), which are wrapped in a `tikzpicture`. `pgfplots`, `tikz-cd` and the common TikZ libraries are loaded. On a dark theme `black` is the theme's ink and `white`, along with tints like `blue!20`, turns dark.
- **Inline math** (`$…$`, `\(…\)`) is converted to Unicode: `$\forall x \in \mathbb{R}$` becomes `∀x ∈ ℝ`, `$x_{n+1}^2$` becomes `xₙ₊₁²`.
- Code blocks, inline code and prices like `$5 and $10` are left alone.
- Anything that fails to compile, or a terminal without image support, falls back to Unicode text (figures to their TikZ code).

## Install

```
/plugin install latex-render --marketplace arthgirard/claude-latex-render
```

Answer `y` to add the marketplace, then pick the user scope to have it in every session.

## Requirements

- A terminal with the kitty graphics protocol: kitty, Ghostty or WezTerm. Inside tmux or over ssh, display math falls back to Unicode text.
- `latex` and `dvipng` on `PATH` (TeX Live: `texlive-scheme-basic` plus `dvipng`, or your distribution's equivalents), with `amsmath`, `amssymb`, `mathtools` and `bm`.
- For figures, `pdflatex` and `pdftocairo` (poppler-utils), with `pgfplots` and `tikz-cd`.
- ImageMagick (`magick`), optional: pads each picture to whole terminal cells so it keeps its proportions.

Without `latex` or `dvipng` the mod still converts all math to Unicode.

## Rendered or as written

`/latex` flips every reply between rendered and the LaTeX as Claude wrote it (`$$…$$`, `\begin{tikzpicture}`, …), ready to copy; `/latex source` and `/latex render` set it directly. While source is on, the status line says so. It works mid-reply and lasts for the session.

LaTeX inside an ordinary code block (` ```latex `, ` ```tex `) is never rendered, so asking Claude for LaTeX code to paste gets code either way.

## Settings

In `/config`:

| Setting | Default | What it does |
| --- | --- | --- |
| `images` | `auto` | `auto` draws pictures in kitty, Ghostty and WezTerm outside tmux/ssh; `on` always; `off` Unicode only |
| `color` | `auto` | Formula color as hex (`#e6e6e6`), or `auto` to follow the light or dark theme |
| `scale` | `1.25` | Terminal rows one line of LaTeX takes |
| `cellAspect` | `2.1` | Cell height ÷ width; raise it if formulas look squashed, lower it if stretched |
| `preamble` | empty | Extra LaTeX preamble, e.g. `\usepackage{physics}` |
| `background` | `auto` | On a dark theme, the terminal background as hex, which figures' `white` and tints become (`auto` is `#1e1e1e`) |

Rendered formulas and figures are cached in `~/.cache/claude-latex-render/`.

## Safety

LaTeX can read any file it can name, even with `openin_any=p`. Formulas and figures that use file or macro primitives (`\input`, `\read`, `\write`, `\catcode`, `\csname`, `\def`, `^^` escapes, …) are never compiled and are shown as Unicode instead. `latex` and `pdflatex` run with `-no-shell-escape` and `openout_any=p`.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

`hooks/register.tsx` hooks the drawing of assistant messages; `hooks/latex.ts` holds the parsing, Unicode conversion and document building; `hooks/latex.test.ts` tests them; `hooks/toggle.test.tsx` drives `/latex` through the engine.

## License

MIT
