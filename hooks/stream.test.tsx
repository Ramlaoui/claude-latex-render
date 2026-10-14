import { describe, expect, test } from 'claude-code/testing'
import type { Chunk, On } from 'claude-code'

const step = { turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 }
const ran = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

// Stands for a session whose processes all succeed and write nothing, and
// records each command's program and when, counted in chunks the engine had streamed.
function world(on: On, surfaces: ('terminal' | 'desktop')[]) {
  const streamed = { count: 0 }
  const runs: { program: string; at: number }[] = []
  on('session.surfaces', () => ({ value: surfaces }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    runs.push({ program: e.argv[0] ?? '', at: streamed.count })
    return { value: ran }
  })
  return { streamed, runs }
}

// The engine's stream: these chunks, then the stop, counting each as it goes.
function engine(on: On, streamed: { count: number }, chunks: Chunk<'turn.step'>[]) {
  on('turn.step', async function* () {
    for (const chunk of [...chunks, { kind: 'stop', stopReason: 'end_turn', usage: null } as const]) {
      streamed.count += 1
      yield chunk
      // Gives work the hooks above started a moment to run, as the network would.
      for (let i = 0; i < 50; i++) await Promise.resolve()
    }
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
}

async function collect(stream: AsyncIterable<Chunk<'turn.step'>>): Promise<Chunk<'turn.step'>[]> {
  const out: Chunk<'turn.step'>[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

const reply: Chunk<'turn.step'>[] = [
  { kind: 'text', index: 0, text: 'Take\n$$x^' },
  { kind: 'text', index: 0, text: '2$$\n\nso it ' },
  { kind: 'text', index: 0, text: 'grows, and more' },
  { kind: 'text', index: 0, text: ' text follows.' },
  { kind: 'tool', index: 1, id: 'tu1', name: 'Read' },
]

describe('turn.step', () => {
  test('a formula is typeset while the reply still streams', { options: { images: 'on' } }, async ($, on) => {
    const { streamed, runs } = world(on, ['terminal'])
    engine(on, streamed, reply)
    const chunks = await collect($.turn.step(step))
    expect(chunks).toEqual([...reply, { kind: 'stop', stopReason: 'end_turn', usage: null }])
    const latex = runs.find(r => r.program === 'latex' && r.at > 0)
    expect(latex?.at).toBeLessThan(reply.length)
  })

  test('a run with no terminal typesets nothing', { options: { images: 'on' } }, async ($, on) => {
    const { streamed, runs } = world(on, [])
    engine(on, streamed, reply)
    await collect($.turn.step(step))
    expect(runs.filter(r => r.at > 0)).toEqual([])
  })
})

// The head of a 200×50 PNG, all a picture's size is read from.
const PNG = btoa(
  String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 200, 0, 0, 0, 50),
)

const band = { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 19 }, view: {} }

describe('preview', () => {
  test('a formula shows above the prompt until its block ends', { options: { images: 'on' } }, async ($, on) => {
    on('session.surfaces', () => ({ value: ['terminal'] as const }))
    on('env.get', () => ({ value: undefined }))
    on('process.run', () => ({ value: ran }))
    // Every picture is already typeset.
    on('fs.exists', (_$, e) => ({ value: e.path.endsWith('.png') }))
    on('fs.read', () => ({ value: { base64: PNG } }))
    // Stands for the engine's own band.
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>prompt band</Text>
    })

    on('turn.step', async function* () {
      yield { kind: 'text', index: 0, text: 'Take\n$$x^2$$\n' } as const
      yield { kind: 'text', index: 0, text: '\nso it grows' } as const
      yield { kind: 'tool', index: 1, id: 'tu1', name: 'Read' } as const
      yield { kind: 'stop', stopReason: 'tool_use', usage: null } as const
      return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: null }
    })
    const view = await $.ui.mount({ plugin: 'latex-render', surface: 'terminal', component: 'AbovePrompt', props: band })
    const previewing = async () => JSON.stringify(await view.drawn()).includes('LaTeX preview')

    // Pulled a chunk at a time: the plugin acts on a chunk when the next is asked for.
    const stream = $.turn.step(step)[Symbol.asyncIterator]()
    await stream.next() // the formula
    expect(await previewing()).toBe(false)
    await stream.next() // the text after it
    expect(await previewing()).toBe(true)
    await stream.next() // the tool call, ending the block
    await stream.next() // the stop
    expect(await previewing()).toBe(false)
    while (!(await stream.next()).done);
  })
})
