import { expect, test } from 'claude-code/testing'

const KEY = { apiKey: 'test-key' }

const jev = (choice: string, confidence: number) => ({
  value: {
    status: 200,
    ok: true,
    headers: {},
    text: JSON.stringify({ answers: { tier: { type: 'choice', choice, confidence, probabilities: {} } } }),
  },
})

const spawn = (subagentType = 'general-purpose', model?: string) => ({
  tool_use_id: 't1',
  prompt: 'Find every call site of fooBar',
  description: 'Find call sites',
  subagentType,
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'sonnet',
  model,
})

test('a subagent is given the model Jev picks', { options: KEY }, async ($, on) => {
  on('http.fetch', () => jev('trivial', 0.9))
  on('clock.sleep', () => new Promise(() => {}))
  on('ui.status', () => ({ value: undefined }))
  const seen: (string | undefined)[] = []
  on('agent.spawn', (_, e) => {
    seen.push(e.model)
    return { model: e.model ?? 'sonnet' }
  })

  await $.agent.spawn({ prompt: 'Find every call site of fooBar', description: 'Find call sites' })

  expect(seen).toEqual(['haiku'])
})

test('low confidence keeps the default model', { options: KEY }, async ($, on) => {
  on('http.fetch', () => jev('hard', 0.2))
  on('clock.sleep', () => new Promise(() => {}))
  const seen: (string | undefined)[] = []
  on('agent.spawn', (_, e) => {
    seen.push(e.model)
    return { model: 'sonnet' }
  })

  await $.agent.spawn({ prompt: 'x', description: 'y' })

  expect(seen).toEqual([undefined])
})

test('an API failure keeps the default model', { options: KEY }, async ($, on) => {
  on('http.fetch', () => ({ value: { status: 500, ok: false, headers: {}, text: '' } }))
  on('clock.sleep', () => new Promise(() => {}))
  const seen: (string | undefined)[] = []
  on('agent.spawn', (_, e) => {
    seen.push(e.model)
    return { model: 'sonnet' }
  })

  await $.agent.spawn({ prompt: 'x', description: 'y' })

  expect(seen).toEqual([undefined])
})

test('no key means no call and no change', async ($, on) => {
  let calls = 0
  on('http.fetch', () => {
    calls++
    return jev('hard', 1)
  })
  const seen: (string | undefined)[] = []
  on('agent.spawn', (_, e) => {
    seen.push(e.model)
    return { model: 'sonnet' }
  })

  await $.agent.spawn({ prompt: 'x', description: 'y' })

  expect(calls).toBe(0)
  expect(seen).toEqual([undefined])
})

test('the key is read from TYPESAFE_API_KEY', async ($, on) => {
  on('env.get', () => ({ value: 'env-key' }))
  const auth: (string | undefined)[] = []
  on('http.fetch', (_, e) => {
    auth.push(e.init?.headers?.authorization)
    return jev('trivial', 0.9)
  })
  on('clock.sleep', () => new Promise(() => {}))
  on('ui.status', () => ({ value: undefined }))
  on('agent.spawn', (_, e) => ({ model: e.model ?? 'sonnet' }))

  await $.agent.spawn({ prompt: 'x', description: 'y' })

  expect(auth).toEqual(['Bearer env-key'])
})

test('a fork is never routed', { options: KEY }, async ($, on) => {
  let calls = 0
  on('http.fetch', () => {
    calls++
    return jev('hard', 1)
  })
  on('clock.sleep', () => new Promise(() => {}))
  on('agent.spawn', () => ({ model: 'sonnet' }))

  await $.agent.spawn({ prompt: 'x', description: 'y', subagentType: 'fork' })

  expect(calls).toBe(0)
})

test('a routed subagent adds its saving to the band', { options: KEY }, async ($, on) => {
  on('http.fetch', () => jev('trivial', 0.9))
  on('clock.sleep', () => new Promise(() => {}))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('agent.spawn', (_, e) => ({ model: e.model ?? 'sonnet', agentId: 'a1' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  // parentModel is sonnet ($3/$15), the subagent ran on haiku ($1/$5): 1M in + 1M out saves $2 + $10.
  await $.agent.spawn({ prompt: 'x', description: 'y' })
  await $.turn.complete({
    answer: 'done',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    agentId: 'a1',
    usage: {
      model: 'claude-haiku-5-5',
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  })

  const ui = await $.ui.mount({
    plugin: 'jev-router',
    surface: 'desktop',
    component: 'AbovePrompt',
    requestId: 'band',
    props: { hasSurvey: false },
  })

  const line = await ui.find({ type: 'Text', text: /this prompt/ })
  expect(line?.text).toContain('this prompt: saved ~$12.00')
  expect(line?.text).toContain('session: saved ~$12.00')
  await ui.unmount()
})

// The engine's side of a main request: records the model asked for and answers with `context` tokens of input.
function engineStep(on: Parameters<Parameters<typeof test>[2]>[1], seen: string[], context = 1000) {
  on('turn.step', async function* (_, e) {
    seen.push(e.model)
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { model: e.model, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: context, cache_creation_input_tokens: 0 },
    }
  })
}

async function step($: Parameters<Parameters<typeof test>[2]>[0], turnId: string, index = 0) {
  const s = $.turn.step({ turnId, index, model: 'claude-sonnet-5-5', messageCount: 2 })
  for await (const _ of s) {
  }
  return s.result
}

const quiet = (on: Parameters<Parameters<typeof test>[2]>[1]) => {
  on('clock.sleep', () => new Promise(() => {}))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('ui.status', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
}

test('a short conversation switches the main turn to the model Jev picks', { options: KEY }, async ($, on) => {
  quiet(on)
  on('http.fetch', () => jev('trivial', 0.9))
  const seen: string[] = []
  engineStep(on, seen)

  await $.prompt.submit({ text: 'Rename a variable' })
  await step($, 't1')

  expect(seen).toEqual(['haiku'])
})

test('the rest of the turn keeps the model its first request chose', { options: KEY }, async ($, on) => {
  quiet(on)
  on('http.fetch', () => jev('trivial', 0.9))
  const seen: string[] = []
  engineStep(on, seen)

  await $.prompt.submit({ text: 'Rename a variable' })
  await step($, 't1', 0)
  await step($, 't1', 1)
  await step($, 't1', 2)

  expect(seen).toEqual(['haiku', 'haiku', 'haiku'])
})

test('a long conversation with a warm cache stays on the session model', { options: KEY }, async ($, on) => {
  quiet(on)
  on('http.fetch', () => jev('trivial', 0.9))
  const seen: string[] = []
  engineStep(on, seen, 150_000)

  // An earlier turn on sonnet leaves 150k tokens cached there. Moving to haiku would write them all afresh:
  // ~$0.22 a turn against ~$0.15 for staying.
  await step($, 't0')
  await $.prompt.submit({ text: 'Rename a variable' })
  await step($, 't1')

  expect(seen).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5'])
})

test('a cold cache makes the switch pay off even in a long conversation', { options: KEY }, async ($, on) => {
  on('clock.sleep', () => new Promise(() => {}))
  on('ui.status', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('http.fetch', () => jev('trivial', 0.9))
  let now = 1_000_000
  on('clock.now', () => ({ value: now }))
  const seen: string[] = []
  engineStep(on, seen, 150_000)

  await step($, 't0')
  now += 10 * 60_000
  await $.prompt.submit({ text: 'Rename a variable' })
  await step($, 't1')

  expect(seen).toEqual(['claude-sonnet-5-5', 'haiku'])
})

test('a pricier pick never moves the main model while downgradeOnly is on', { options: KEY }, async ($, on) => {
  quiet(on)
  on('http.fetch', () => jev('hard', 0.9))
  const seen: string[] = []
  engineStep(on, seen)

  await $.prompt.submit({ text: 'Redesign the auth layer' })
  await step($, 't1')

  expect(seen).toEqual(['claude-sonnet-5-5'])
})

test('switchMain off leaves the main model alone', { options: { ...KEY, switchMain: false } }, async ($, on) => {
  quiet(on)
  on('http.fetch', () => jev('trivial', 0.9))
  const seen: string[] = []
  engineStep(on, seen)

  await $.prompt.submit({ text: 'Rename a variable' })
  await step($, 't1')

  expect(seen).toEqual(['claude-sonnet-5-5'])
})

test('a switched main turn adds its saving to the band', { options: KEY }, async ($, on) => {
  quiet(on)
  on('http.fetch', () => jev('trivial', 0.9))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const seen: string[] = []
  engineStep(on, seen)

  // Ran on haiku ($1/$5) instead of sonnet ($3/$15): 1M in + 1M out saves $2 + $10.
  await $.prompt.submit({ text: 'Rename a variable' })
  await step($, 't1')
  await $.turn.complete({
    answer: 'done',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: {
      model: 'claude-haiku-5-5',
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  })

  const ui = await $.ui.mount({
    plugin: 'jev-router',
    surface: 'desktop',
    component: 'AbovePrompt',
    requestId: 'band3',
    props: { hasSurvey: false },
  })

  expect((await ui.find({ type: 'Text', text: /this prompt/ }))?.text).toContain('this prompt: saved ~$12.00')
  expect((await ui.find({ type: 'Text', text: /switched main to haiku/ }))?.text).toContain('cheaper this turn')
  await ui.unmount()
})
