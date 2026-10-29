import type { EngineInterface, Register } from 'claude-code'

const URL = 'https://api.typesafe.ai/v1/systemone'

const CRITERIA = {
  trivial: 'A quick lookup, search, listing, rename, formatting or other small mechanical edit that needs little reasoning.',
  standard: 'Ordinary implementation, review, test writing, explanation or debugging of a contained problem.',
  hard: 'Architecture or design decisions, subtle or cross-cutting debugging, security analysis, or reasoning over many files at once.',
}

type Tier = keyof typeof CRITERIA

type Pick = { tier: Tier; confidence: number }

type Config = { key: string; timeoutMs: number }

async function route($: EngineInterface, cfg: Config, task: string): Promise<Pick | undefined> {
  const key = cfg.key !== '' ? cfg.key : ((await $.env.get('TYPESAFE_API_KEY')) ?? '')
  if (key === '' || task.trim() === '') return undefined

  const call = $.http
    .fetch(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'jev-latest',
        state: { task: task.slice(0, 6000) },
        questions: {
          tier: {
            type: 'choice',
            instructions: 'How much reasoning capability does the work described in `task` need from the AI model that will carry it out?',
            criteria: CRITERIA,
          },
        },
      }),
    })
    .then((res): Pick | undefined => {
      if (!res.ok) return undefined
      const a = JSON.parse(res.text)?.answers?.tier
      return a && a.choice in CRITERIA ? { tier: a.choice, confidence: Number(a.confidence) } : undefined
    })
    .catch(() => undefined)

  const timeout = $.clock.sleep(cfg.timeoutMs).then(() => undefined)

  return Promise.race([call, timeout])
}

export const register: Register = (on, options) => {
  const key = String(options.apiKey ?? '')
  const minConfidence = Number(options.minConfidence ?? 0.5)
  const timeoutMs = Number(options.timeoutMs ?? 4000)
  const cfg: Config = { key, timeoutMs }
  const models: Record<Tier, string> = {
    trivial: String(options.trivialModel ?? 'haiku'),
    standard: String(options.standardModel ?? 'sonnet'),
    hard: String(options.hardModel ?? 'opus'),
  }

  const usable = (p: Pick | undefined): p is Pick => p !== undefined && p.confidence >= minConfidence

  // Subagents: Jev picks the model. Forks always inherit, so they are left alone.
  on('agent.spawn', async ($, e, next) => {
    if (e.subagentType === 'fork' || e.model !== undefined) return next(e)

    const pick = await route($, cfg, `${e.description}\n\n${e.prompt}`)
    if (!usable(pick)) return next(e)

    $.ui.status(`Jev → ${models[pick.tier]} (${pick.tier}, ${pick.confidence.toFixed(2)}) for "${e.description.slice(0, 30)}"`)

    return next({ ...e, model: models[pick.tier] })
  }).catch(($, e, next) => next(e))

  // Main conversation: the engine gives a mod no way to switch the model, so this only reports Jev's pick.
  if (options.showMain !== false) {
    on('prompt.submit', async ($, e, next) => {
      if (e.command || e.isMeta) return next(e)

      const pick = await route($, cfg, e.text)
      if (usable(pick)) {
        $.ui.status(`Jev suggests ${models[pick.tier]} (${pick.tier}, ${pick.confidence.toFixed(2)})`)
      }

      return next(e)
    }).catch(($, e, next) => next(e))
  }
}
