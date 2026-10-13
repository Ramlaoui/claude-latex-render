# claude-latex-render

A Claude Code mod that renders LaTeX math in Claude's replies, right in the terminal.

- **Display math** (`$$…$$`, `\[…\]`, `equation`, `align`, `gather`, …) is typeset with `latex` + `dvipng` and drawn as a crisp image through the kitty graphics protocol.
- **Inline math** (`$…$`, `\(…\)`) is converted to Unicode: `$\forall x \in \mathbb{R}$` becomes `∀x ∈ ℝ`, `$x_{n+1}^2$` becomes `xₙ₊₁²`.
- Code blocks, inline code and prices like `$5 and $10` are left alone.
- Anything that fails to compile, or a terminal without image support, falls back to Unicode text.

## Install

```
/plugin install latex-render --marketplace arthgirard/claude-latex-render
```

Answer `y` to add the marketplace, then pick the user scope to have it in every session.

## Requirements

- A terminal with the kitty graphics protocol: kitty, Ghostty or WezTerm. Inside tmux or over ssh, display math falls back to Unicode text.
- `latex` and `dvipng` on `PATH` (TeX Live: `texlive-scheme-basic` plus `dvipng`, or your distribution's equivalents), with `amsmath`, `amssymb`, `mathtools` and `bm`.
- ImageMagick (`magick`), optional: pads each picture to whole terminal cells so it keeps its proportions.

Without `latex` or `dvipng` the mod still converts all math to Unicode.

## Settings

In `/config`:

| Setting | Default | What it does |
| --- | --- | --- |
| `images` | `auto` | `auto` draws pictures in kitty, Ghostty and WezTerm outside tmux/ssh; `on` always; `off` Unicode only |
| `color` | `auto` | Formula color as hex (`#e6e6e6`), or `auto` to follow the light or dark theme |
| `scale` | `1.25` | Terminal rows one line of LaTeX takes |
| `cellAspect` | `2.1` | Cell height ÷ width; raise it if formulas look squashed, lower it if stretched |
| `preamble` | empty | Extra LaTeX preamble, e.g. `\usepackage{physics}` |

Rendered formulas are cached in `~/.cache/claude-latex-render/`.

## Safety

LaTeX can read any file it can name, even with `openin_any=p`. Formulas that use file or macro primitives (`\input`, `\read`, `\write`, `\catcode`, `\csname`, `\def`, `^^` escapes, …) are never compiled and are shown as Unicode instead. `latex` runs with `-no-shell-escape` and `openout_any=p`.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

`hooks/register.tsx` hooks the drawing of assistant messages; `hooks/latex.ts` holds the parsing, Unicode conversion and document building; `hooks/latex.test.ts` tests them.

## License

MIT
