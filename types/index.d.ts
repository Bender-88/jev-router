declare module 'claude-code' {
  interface PluginState {
    'jev-router': {
      decision: string | null
      promptSaved: number
      sessionSaved: number
      isHidden: boolean
    }
  }
}
