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
// The main turn in progress: the model its steps run on, and the session's own model it was weighed against.
const mainTurn = atom({ plugin: 'jev-router', key: 'mainTurn' } as const, null)
// The last main request: the model that answered, its context size in tokens, and when it ended. Whose cache is warm.
const lastMain = atom({ plugin: 'jev-router', key: 'lastMain' } as const, null)
// Running averages of a main turn's requests and output tokens, to estimate what the next turn will cost.
const turnShape = atom({ plugin: 'jev-router', key: 'turnShape' } as const, { steps: 3, output: 1000 })

// Cache reads and writes as a share of the input price.
const CACHE_READ = 0.1
const CACHE_WRITE = 1.25
// A switch must beat staying by this share of the cost of staying, so estimate noise never flips the model.
const MARGIN = 0.1
const RANK: Record<string, number> = { haiku: 0, sonnet: 1, opus: 2 }

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

type Shape = { steps: number; output: number }

// What one main turn on `model` is expected to cost: its first request reads the context from cache when that
// model's cache is warm and writes it afresh when not, each later request reads it from cache, and the output is
// the usual amount. Undefined for a model with no price.
function turnCost(prices: Prices, model: string, context: number, isWarm: boolean, shape: Shape): number | undefined {
  const family = Object.keys(prices).find(f => model.includes(f))
  if (family === undefined) return undefined
  const [input, output] = prices[family]!
  const first = context * input * (isWarm ? CACHE_READ : CACHE_WRITE)
  const rest = Math.max(shape.steps - 1, 0) * context * input * CACHE_READ
  return (first + rest + shape.output * output) / 1_000_000
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

type MainConfig = { prices: Prices; downgradeOnly: boolean; cacheTtlMs: number }

// Which model a main turn runs on: Jev's pick when switching to it is expected to cost less than staying on the
// session's model, counting the cache each one has warm. A long conversation makes a cold switch expensive, so
// there Jev's pick has to save a lot per turn to win.
async function chooseMain($: EngineInterface, base: string, m: MainConfig): Promise<{ model: string; detail: string } | undefined> {
  const pick = await read($, mainPick)
  if (pick === null || family(pick) === family(base)) return undefined
  if (m.downgradeOnly && (RANK[family(pick)] ?? 99) >= (RANK[family(base)] ?? 99)) return undefined

  const last = await read($, lastMain)
  const shape = await read($, turnShape)
  const now = await $.clock.now()
  const warm = last !== null && now - last.at < m.cacheTtlMs ? family(last.model) : undefined
  const context = last?.context ?? 0

  const stay = turnCost(m.prices, base, context, warm === family(base), shape)
  const go = turnCost(m.prices, pick, context, warm === family(pick), shape)
  if (stay === undefined || go === undefined) return undefined

  const tokens = `${Math.round(context / 1000)}k tokens of context`
  if (go < stay * (1 - MARGIN)) {
    return { model: pick, detail: `switched main to ${family(pick)} · ~${money(stay - go)} cheaper this turn · ${tokens}` }
  }
  return { model: base, detail: `kept ${family(base)}: a switch would not pay off · ${tokens}` }
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
  const switchMain = options.switchMain !== false
  const main: MainConfig = {
    prices,
    downgradeOnly: options.downgradeOnly !== false,
    cacheTtlMs: Number(options.cacheTtlMinutes ?? 5) * 60_000,
  }

  const usable = (p: Pick | undefined): p is Pick => p !== undefined && p.confidence >= minConfidence

  // Main requests: the turn's first one decides the model, the rest of the turn keeps it so its cache stays warm.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)

    let model = e.model
    try {
      const turn = await read($, mainTurn)
      if (turn !== null && turn.turnId === e.turnId) {
        model = turn.model
        await update($, mainTurn, t => (t === null ? t : { ...t, steps: t.steps + 1 }))
      } else {
        const choice = switchMain ? await chooseMain($, e.model, main) : undefined
        model = choice?.model ?? e.model
        await update($, mainTurn, () => ({ turnId: e.turnId, model, base: e.model, steps: 1 }))
        if (choice !== undefined) {
          const d = await read($, decision)
          if (d !== null) await update($, decision, () => ({ badge: d.badge, detail: choice.detail }))
        }
      }
    } catch {
      model = e.model
    }

    const res = yield* next(model === e.model ? e : { ...e, model })

    const u = res.usage
    if (u !== null) {
      const at = await $.clock.now()
      const context = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens
      await update($, lastMain, () => ({ model: u.model, context, at }))
    }
    return res
  })

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
  // A main turn counts only when it was switched: priced at what it ran on against the session's own model.
  on('turn.complete', async ($, e, next) => {
    if (e.usage !== undefined) {
      let diff: number | undefined
      if (e.agentId !== undefined) {
        const baseline = ((await read($, routed)) as Record<string, string>)[e.agentId]
        const actual = cost(prices, e.usage.model, e.usage)
        const would = baseline === undefined ? undefined : cost(prices, baseline, e.usage)
        if (actual !== undefined && would !== undefined) diff = would - actual
      } else {
        const turn = await read($, mainTurn)
        if (turn !== null && turn.turnId === e.turnId) {
          const steps = turn.steps
          const output = e.usage.output_tokens
          await update($, turnShape, s => ({ steps: s.steps * 0.7 + steps * 0.3, output: s.output * 0.7 + output * 0.3 }))
          // A switched turn is priced against the session's model with its cache assumed warm, the cheaper case for
          // staying, so the saving shown is the smaller one.
          if (family(turn.model) !== family(turn.base)) {
            const u = e.usage
            const warm = { ...u, cache_read_input_tokens: u.cache_read_input_tokens + u.cache_creation_input_tokens, cache_creation_input_tokens: 0 }
            const actual = cost(prices, u.model, u)
            const would = cost(prices, turn.base, warm)
            if (actual !== undefined && would !== undefined) diff = would - actual
          }
        }
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
