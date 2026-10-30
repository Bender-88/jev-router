import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const URL = 'https://api.typesafe.ai/v1/systemone'
const PINK = '#e650bb'

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

type Decision = { badge: string; detail: string }

const decision = atom({ plugin: 'jev-router', key: 'decision' } as const, null)
const promptSaved = atom({ plugin: 'jev-router', key: 'promptSaved' } as const, 0)
const sessionSaved = atom({ plugin: 'jev-router', key: 'sessionSaved' } as const, 0)
// Routed subagents by id: the model the session would otherwise have used. Kept in state so a reload keeps it.
const routed = atom({ plugin: 'jev-router', key: 'routed' } as const, {})
// The model Jev suggested for the current main prompt; its turns are priced against it.
const mainPick = atom({ plugin: 'jev-router', key: 'mainPick' } as const, null)
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
  return `$${Math.abs(n).toFixed(2)}`
}

function family(model: string): string {
  return ['haiku', 'sonnet', 'opus'].find(f => model.includes(f)) ?? model
}

function saving(n: number): string {
  return n >= 0 ? `saved ~${money(n)}` : `~${money(n)} more`
}

async function sessionModel($: EngineInterface, parent: string | undefined): Promise<string> {
  if (parent !== undefined) return parent
  try {
    return await $.session.model()
  } catch {
    return 'unknown'
  }
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

  const usable = (p: Pick | undefined): p is Pick => p !== undefined && p.confidence >= minConfidence

  // A new prompt starts a new per-prompt tally.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)

    await update($, promptSaved, () => 0)
    await update($, mainPick, () => null)
    $.ui.status(undefined)

    if (options.showMain !== false) {
      const pick = await route($, cfg, e.text)
      if (usable(pick)) {
        await update($, mainPick, () => models[pick.tier])
        await update($, decision, () => ({
          badge: `${pick.tier} → ${models[pick.tier]} · ${Math.round(pick.confidence * 100)}%`,
          detail: 'suggested for your prompt',
        }))
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // Subagents: Jev picks the model. Forks always inherit, so they are left alone.
  on('agent.spawn', async ($, e, next) => {
    if (e.subagentType === 'fork' || e.model !== undefined) return next(e)

    const pick = await route($, cfg, `${e.description}\n\n${e.prompt}`)
    if (!usable(pick)) return next(e)

    const baseline = await sessionModel($, e.parentModel)
    await update($, decision, () => ({
      badge: `${pick.tier} → ${models[pick.tier]} · ${Math.round(pick.confidence * 100)}%`,
      detail: `${e.description.slice(0, 40)} · ${family(baseline)} → ${family(models[pick.tier])}`,
    }))

    const started = await next({ ...e, model: models[pick.tier] })
    if (started.agentId !== undefined) {
      const id = started.agentId
      await update($, routed, m => ({ ...(m as Record<string, string>), [id]: baseline }))
    }

    return started
  }).catch(($, e, next) => next(e))

  // When a routed subagent ends, price what it used against what the session's own model would have charged.
  // A routed subagent's tokens are priced at what it ran on against what the session's model would have charged.
  // A main turn is priced at the session's model against Jev's suggestion; the model is not switched, so that part is an estimate.
  on('turn.complete', async ($, e, next) => {
    if (e.usage !== undefined) {
      let diff: number | undefined
      if (e.agentId !== undefined) {
        const baseline = ((await read($, routed)) as Record<string, string>)[e.agentId]
        const actual = cost(prices, e.usage.model, e.usage)
        const would = baseline === undefined ? undefined : cost(prices, baseline, e.usage)
        if (actual !== undefined && would !== undefined) diff = would - actual
      } else {
        const suggested = await read($, mainPick)
        const actual = cost(prices, e.usage.model, e.usage)
        const alt = suggested === null ? undefined : cost(prices, suggested, e.usage)
        if (actual !== undefined && alt !== undefined) diff = actual - alt
      }
      if (diff !== undefined) {
        const d = diff
        await update($, promptSaved, n => n + d)
        await update($, sessionSaved, n => n + d)
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    $.ui.status(undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const d = await read($, decision)
    if (e.props.hasSurvey || d === null || typeof d !== 'object' || (await read($, isHidden))) return next(e)

    const prompt = await read($, promptSaved)
    const session = await read($, sessionSaved)
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box borderStyle="round" borderColor={PINK} paddingX={1} flexDirection="column">
        <Box gap={1}>
          <Text color={PINK} bold>
            ◈ JEV
          </Text>
          <Text color={PINK}>typesafe.ai</Text>
          <Text color={PINK}>●</Text>
          <Text color={PINK}>{d.badge}</Text>
          <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
        </Box>
        <Text color={PINK}>{d.detail}</Text>
        <Text color={PINK}>
          this prompt: {saving(prompt)} · session: {saving(session)}
        </Text>
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
