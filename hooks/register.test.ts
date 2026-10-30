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

test('a main turn is priced against the model Jev suggests', { options: KEY }, async ($, on) => {
  on('http.fetch', () => jev('trivial', 0.9))
  on('clock.sleep', () => new Promise(() => {}))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('ui.status', () => ({ value: undefined }))

  // The session ran on sonnet ($3/$15); Jev suggests haiku ($1/$5): 1M in + 1M out is $12 cheaper.
  await $.prompt.submit({ text: 'Rename a variable' })
  await $.turn.complete({
    answer: 'done',
    durationMs: 1,
    isAborted: false,
    turnId: 't2',
    reason: 'answer',
    usage: {
      model: 'claude-sonnet-5-5',
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
    requestId: 'band2',
    props: { hasSurvey: false },
  })

  const line = await ui.find({ type: 'Text', text: /this prompt/ })
  expect(line?.text).toContain('this prompt: saved ~$12.00')
  await ui.unmount()
})
