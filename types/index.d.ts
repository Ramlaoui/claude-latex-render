/** How replies are drawn: LaTeX typeset as pictures, or left as written. */
export type Mode = 'render' | 'source'

/** A formula or figure typeset while its reply still streams, shown above the prompt. */
export type Previewed = { kind: 'display'; tex: string; env?: string } | { kind: 'figure'; tex: string }

declare module 'claude-code' {
  interface PluginState {
    'latex-render': { mode: Mode; preview: Previewed[] }
  }
}
