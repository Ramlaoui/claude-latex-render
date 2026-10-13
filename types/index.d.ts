/** How replies are drawn: LaTeX typeset as pictures, or left as written. */
export type Mode = 'render' | 'source'

declare module 'claude-code' {
  interface PluginState {
    'latex-render': { mode: Mode }
  }
}
