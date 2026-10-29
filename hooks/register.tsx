import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const URL = 'https://api.typesafe.ai/v1/systemone'
const PURPLE = '#a855f7'

const CRITERIA = {
  trivial: 'A quick lookup, search, listing, rename, formatting or other small mechanical edit that needs little reasoning.',
  standard: 'Ordinary implementation, review, test writing, explanation or debugging of a contained problem.',
  hard: 'Architecture or design decisions, subtle or cross-cutting debugging, security analysis, or reasoning over many files at once.',
}

type Tier = keyof typeof CRITERIA

type Pick = { tier: Tier; confidence: number }

type Config = { key: string; timeoutMs: number }

// Dollars per million tokens: [input, output]. Estimates; override with the `prices` option.
type Prices = Record<string, readonly [number, number]>

const DEFAULT_PRICES: Prices = { haiku: [1, 5], sonnet: [3, 15], opus: [5, 25] }

const decision = atom({ plugin: 'jev-router', key: 'decision' } as const, null)
const promptSaved = atom({ plugin: 'jev-router', key: 'promptSaved' } as const, 0)
const sessionSaved = atom({ plugin: 'jev-router', key: 'sessionSaved' } as const, 0)
const isHidden = atom({ plugin: 'jev-router', key: 'isHidden' } as const, false)

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

function parsePrices(raw: string): Prices {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? { ...DEFAULT_PRICES, ...parsed } : DEFAULT_PRICES
  } catch {
    return DEFAULT_PRICES
  }
}

function cost(prices: Prices, model: string, u: Usage): number | undefined {
  const family = Object.keys(prices).find(f => model.includes(f))
  if (family === undefined) return undefined
  const [input, output] = prices[family]!
  const million = 1_000_000
  return (
    (u.input_tokens * input +
      u.output_tokens * output +
      u.cache_read_input_tokens * input * 0.1 +
      u.cache_creation_input_tokens * input * 1.25) /
    million
  )
}

function money(n: number): string {
  const abs = Math.abs(n)
  return `$${abs < 0.1 ? abs.toFixed(4) : abs.toFixed(2)}`
}

function saving(n: number): string {
  return n >= 0 ? `saved ~${money(n)}` : `~${money(n)} more`
}

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
  const prices = parsePrices(String(options.prices ?? ''))
  const models: Record<Tier, string> = {
    trivial: String(options.trivialModel ?? 'haiku'),
    standard: String(options.standardModel ?? 'sonnet'),
    hard: String(options.hardModel ?? 'opus'),
  }

  // Routed subagents by id: the model the session would otherwise have used.
  const baselines = new Map<string, string>()

  const usable = (p: Pick | undefined): p is Pick => p !== undefined && p.confidence >= minConfidence

  // A new prompt starts a new per-prompt tally.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)

    await update($, promptSaved, () => 0)

    if (options.showMain !== false) {
      const pick = await route($, cfg, e.text)
      if (usable(pick)) {
        await update($, decision, () => `Jev suggests ${models[pick.tier]} (${pick.tier}, ${pick.confidence.toFixed(2)})`)
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // Subagents: Jev picks the model. Forks always inherit, so they are left alone.
  on('agent.spawn', async ($, e, next) => {
    if (e.subagentType === 'fork' || e.model !== undefined) return next(e)

    const pick = await route($, cfg, `${e.description}\n\n${e.prompt}`)
    if (!usable(pick)) return next(e)

    await update($, decision, () => `Jev → ${models[pick.tier]} (${pick.tier}, ${pick.confidence.toFixed(2)}) for "${e.description.slice(0, 30)}"`)

    const started = await next({ ...e, model: models[pick.tier] })
    if (started.agentId !== undefined) baselines.set(started.agentId, e.parentModel ?? (await $.session.model()))

    return started
  }).catch(($, e, next) => next(e))

  // When a routed subagent ends, price what it used against what the session's own model would have charged.
  on('turn.complete', async ($, e, next) => {
    const baseline = e.agentId === undefined ? undefined : baselines.get(e.agentId)
    if (baseline !== undefined && e.usage !== undefined) {
      const actual = cost(prices, e.usage.model, e.usage)
      const would = cost(prices, baseline, e.usage)
      if (actual !== undefined && would !== undefined) {
        const diff = would - actual
        await update($, promptSaved, n => n + diff)
        await update($, sessionSaved, n => n + diff)
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const text = await read($, decision)
    if (e.props.hasSurvey || text === null || (await read($, isHidden))) return next(e)

    const prompt = await read($, promptSaved)
    const session = await read($, sessionSaved)
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text color={PURPLE}>
          {text} · this prompt: {saving(prompt)} · session: {saving(session)}{' '}
        </Text>
        <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
