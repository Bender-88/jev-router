declare module 'claude-code' {
  interface PluginState {
    'jev-router': {
      decision: { badge: string; detail: string } | null
      promptSaved: number
      sessionSaved: number
      isHidden: boolean
      mainPick: string | null
      routed: Record<string, string>
    }
  }
}
