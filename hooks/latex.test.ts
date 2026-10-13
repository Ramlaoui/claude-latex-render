import { describe, expect, test } from 'claude-code/testing'

import {
  displayToUnicode,
  dvipngColor,
  figureDocument,
  hashKey,
  hasMath,
  inlineToUnicode,
  isSafeTex,
  pngSize,
  segmentsToUnicode,
  splitMath,
  texDocument,
  texToUnicode,
} from './latex'

describe('splitMath', () => {
  test('finds $$, \\[ and environment display math', async () => {
    const parts = splitMath('A\n$$x^2$$\nB \\[ y \\] C\n\\begin{align}a &= b\\end{align}\n')
    expect(parts.filter(p => p.kind === 'display').map(p => (p as { tex: string }).tex)).toEqual([
      'x^2',
      'y',
      'a &= b',
    ])
    expect(parts[5]).toEqual({ kind: 'display', tex: 'a &= b', env: 'align' })
  })

  test('leaves fenced and inline code alone', async () => {
    const text = '```tex\n$$x$$\n```\nand `$$y$$` here'
    expect(splitMath(text)).toEqual([{ kind: 'markdown', text }])
  })
})

describe('inlineToUnicode', () => {
  test('converts $...$ and \\(...\\)', async () => {
    expect(inlineToUnicode('Let $\\alpha \\leq \\beta$ and \\(x^2\\).')).toBe('Let α ≤ β and x².')
  })

  test('keeps prices and code', async () => {
    expect(inlineToUnicode('costs $5 and $10, `$x$`')).toBe('costs $5 and $10, `$x$`')
  })

  test('escapes markdown in the result', async () => {
    expect(inlineToUnicode('$a_{ij}^*$')).toBe('aᵢⱼ\\*')
  })
})

describe('texToUnicode', () => {
  test('fractions, roots and scripts', async () => {
    expect(texToUnicode('\\frac{a+b}{2}')).toBe('(a + b)/2')
    expect(texToUnicode('\\sqrt{x}')).toBe('√x')
    expect(texToUnicode('e^{i\\pi} + 1 = 0')).toBe('e^(iπ) + 1 = 0')
    expect(texToUnicode('x_{n+1}')).toBe('xₙ₊₁')
    expect(texToUnicode("f'(x)")).toBe('f′(x)')
  })

  test('sets, operators and fonts', async () => {
    expect(texToUnicode('\\forall x \\in \\mathbb{R}, \\exists n \\in \\mathbb{N}')).toBe('∀x ∈ ℝ, ∃n ∈ ℕ')
    expect(texToUnicode('\\sum_{i=1}^{n} i')).toBe('∑ᵢ₌₁ⁿ i')
    expect(texToUnicode('\\lim_{x \\to 0} \\frac{\\sin x}{x}')).toBe('lim_(x → 0) (sin x)/x')
    expect(texToUnicode('\\vec{v} \\cdot \\hat{n}')).toBe('v⃗ · n̂')
    expect(texToUnicode('\\sqrt{\\operatorname{tr}^2 A - 4\\det A}')).toBe('√(tr² A - 4 det A)')
  })

  test('matrices and cases', async () => {
    expect(texToUnicode('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}')).toBe('(a b; c d)')
    expect(texToUnicode('|x| = \\begin{cases} x & x \\ge 0 \\\\ -x & \\text{otherwise} \\end{cases}')).toBe(
      '|x| = { x, x ≥ 0; -x, otherwise',
    )
  })
})

describe('typesetting helpers', () => {
  test('displayToUnicode makes one indented line per row', async () => {
    expect(displayToUnicode('a &= b \\\\ c &= d')).toBe('\n\n    a = b  \n    c = d\n\n')
  })

  test('texDocument stars numbered environments and picks align for &', async () => {
    expect(texDocument({ tex: 'x', env: 'equation' }, '')).toContain('\\begin{gather*}')
    expect(texDocument({ tex: 'a &= b' }, '')).toContain('\\begin{align*}')
    expect(texDocument({ tex: '\\begin{pmatrix}a&b\\end{pmatrix}' }, '')).toContain('\\begin{gather*}')
  })

  test('isSafeTex refuses file access and macro tricks', async () => {
    expect(isSafeTex('\\int_0^1 f(x)\\,dx')).toBe(true)
    expect(isSafeTex('\\input{/etc/passwd}')).toBe(false)
    expect(isSafeTex('\\csname input\\endcsname')).toBe(false)
    expect(isSafeTex('^^5cinput')).toBe(false)
    expect(isSafeTex('\\inputfoo')).toBe(true)
  })

  test('pngSize, dvipngColor, hashKey', async () => {
    // An 8-byte signature, then IHDR declaring 352 x 102.
    const header = '\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x01\x60\x00\x00\x00\x66'
    expect(pngSize(btoa(header + '\x08\x03\x00\x00\x00'))).toEqual({ width: 352, height: 102 })
    expect(dvipngColor('#ffffff')).toBe('rgb 1.000 1.000 1.000')
    expect(dvipngColor('nope')).toBeUndefined()
    expect(hashKey('a')).not.toBe(hashKey('b'))
    expect(hashKey('a')).toHaveLength(16)
  })
})

describe('figures', () => {
  test('a closed ```tikz fence is a figure', async () => {
    const parts = splitMath('Before\n```tikz\n\\draw (0,0) -- (1,1);\n```\nAfter')
    expect(parts).toEqual([
      { kind: 'markdown', text: 'Before\n' },
      { kind: 'figure', tex: '\\draw (0,0) -- (1,1);' },
      { kind: 'markdown', text: 'After' },
    ])
  })

  test('an unclosed ```tikz fence, still streaming, stays text', async () => {
    const text = 'See\n```tikz\n\\draw (0,0) -- (1,1);\n'
    expect(splitMath(text)).toEqual([{ kind: 'markdown', text }])
  })

  test('a bare tikzpicture or tikzcd is a figure, math inside it and all', async () => {
    const pic = '\\begin{tikzpicture}\\node at (0,0) {$x^2$};\\end{tikzpicture}'
    const cd = '\\begin{tikzcd} A \\arrow[r, "f"] & B \\end{tikzcd}'
    const parts = splitMath(`One ${pic} two\n${cd}`)
    expect(parts.filter(p => p.kind === 'figure')).toEqual([
      { kind: 'figure', tex: pic },
      { kind: 'figure', tex: cd },
    ])
  })

  test('a reply with only a tikz fence is noticed', async () => {
    expect(hasMath('```tikz\n\\draw (0,0) circle (1);\n```')).toBe(true)
    expect(hasMath('```ts\nconst x = 1\n```')).toBe(false)
  })

  test('a figure that cannot be drawn is shown as its code', async () => {
    expect(segmentsToUnicode([{ kind: 'figure', tex: '\\draw (0,0) -- (1,0);' }])).toBe(
      '\n\n```tex\n\\draw (0,0) -- (1,0);\n```\n\n',
    )
  })

  test('bare commands are wrapped in a tikzpicture, environments are not', async () => {
    const wrapped = figureDocument('\\draw (0,0) -- (1,0);', '', 'e6e6e6')
    expect(wrapped).toContain('\\begin{tikzpicture}\n\\draw (0,0) -- (1,0);\n\\end{tikzpicture}')
    const cd = figureDocument('\\begin{tikzcd} A \\end{tikzcd}', '', 'e6e6e6')
    expect(cd).not.toContain('\\begin{tikzpicture}')
  })

  test('a dark paper turns white and tints dark, a light theme leaves them', async () => {
    const dark = figureDocument('\\draw (0,0) -- (1,0);', '', '#e6e6e6', '#1e1e1e')
    expect(dark).toContain('\\definecolor{black}{HTML}{e6e6e6}')
    expect(dark).toContain('\\definecolor{white}{HTML}{1e1e1e}')
    expect(dark).toContain('\\def\\XC@clr@rgb@white{0.118,0.118,0.118}')
    const light = figureDocument('\\draw (0,0) -- (1,0);', '', '1f1f1f')
    expect(light).not.toContain('{white}')
  })
})
