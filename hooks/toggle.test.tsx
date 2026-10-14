import { describe, expect, test } from 'claude-code/testing'

const REPLY = 'Let $\\alpha \\leq \\beta$ hold.'

// `/latex <args>` as the person types it at the prompt.
const latex = (args: string) => ({
  command: 'latex',
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: false, columns: 80 },
})

describe('/latex', () => {
  test('source draws replies as written, render converts them again', async ($, on) => {
    // Stands for the engine's own drawing: shows the text it is handed.
    on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>{e.props.text}</Text>
    })
    const view = await $.ui.mount({
      plugin: 'latex-render',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { text: REPLY, isFirstOfReply: true },
    })
    const shown = async () => JSON.stringify(await view.drawn())

    expect(await shown()).toContain('Let α ≤ β hold.')

    const toSource = await $.command.run(latex('source'))
    expect(toSource.text).toBe('LaTeX is shown as written.')
    expect(await shown()).toContain('Let $\\\\alpha \\\\leq \\\\beta$ hold.')

    const flipped = await $.command.run(latex(''))
    expect(flipped.text).toBe('LaTeX is rendered.')
    expect(await shown()).toContain('Let α ≤ β hold.')
  })

  test('a summary row gets its math in Unicode too', async ($, on) => {
    on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>{e.props.text}</Text>
    })
    const view = await $.ui.mount({
      plugin: 'latex-render',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { text: 'Found the $n$th root at $0$', isFirstOfReply: true, isSummary: true },
    })
    expect(JSON.stringify(await view.drawn())).toContain('Found the nth root at 0')
  })

  test('an unknown argument changes nothing', async $ => {
    const answer = await $.command.run(latex('sideways'))
    expect(answer.text).toBe('Usage: /latex [render|source]')
  })
})
