declare module 'claude-code' {
  interface PluginState {
    'jev-router': {
      decision: { badge: string; detail: string } | null
      promptSaved: number
      sessionSaved: number
      isHidden: boolean
      mainPick: string | null
      routed: Record<string, string>
      mainTurn: { turnId: string; model: string; base: string; steps: number } | null
      lastMain: { model: string; context: number; at: number } | null
      turnShape: { steps: number; output: number }
    }
  }
}
