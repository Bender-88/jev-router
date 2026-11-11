# jev-router

A Claude Code mod that uses [TypeSafe](https://typesafe.ai)'s Jev model to pick which Claude model each subagent and each main turn runs on, based on the task, switching the main conversation only when that saves money.

## What it does

- **Subagents:** before a subagent starts, Jev classifies its task as `trivial`, `standard` or `hard`. The mod sets the subagent's model to haiku, sonnet or opus accordingly.
- **Pink band above the prompt:** a rounded box in TypeSafe pink with a `◈ JEV` mark, Jev's latest decision (tier, model, confidence), the task with the route (for example `sonnet → haiku`), and an estimate of what routing saved, for the current prompt and for the whole session, for example `this prompt: saved ~$0.21 · session: saved ~$1.30`. Amounts show 2 decimals. It has a Hide button.
- **How savings are estimated:** when a routed subagent finishes, its tokens are priced at the model it ran on and at your session's own model, and the difference is the saving. Cache reads and writes are estimated at 10% and 125% of the input price. These are rough figures based on the `prices` option, not billing data, and they say nothing about answer quality. Forks are never routed, so they add no savings. A main-conversation turn counts only when it was switched: its tokens are priced at the model it ran on and at the session's model, with the session's cache assumed warm, so the saving shown is the smaller estimate. It assumes the cheaper model would use the same tokens.
- **Forks:** never routed. A fork always inherits its parent's model.
- **Explicit models:** a subagent that already names a model is left alone.
- **Main conversation:** Jev classifies each prompt you send. When its pick is a cheaper model than the session's, the mod weighs whether switching actually saves money before it switches. Each model caches the conversation separately, so a switch makes the new model read the whole conversation at the cache-write price (125% of input) instead of the cache-read price (10%). The mod estimates one turn on each model from the last request's context size, whether each model's cache is still warm (`cacheTtlMinutes`), and the usual number of requests and output tokens per turn, and switches only when Jev's pick comes out at least 10% cheaper. In a short conversation, or after the cache has gone cold, a switch usually pays off; in a long one with a warm cache it usually does not, and the session's model is kept. The first request of a turn decides, and the rest of that turn stays on the same model. The pink band says which happened, for example `switched main to haiku · ~$0.04 cheaper this turn · 12k tokens of context`. Turn switching off with `switchMain`; by default (`downgradeOnly`) the mod never moves you to a pricier model than the one you chose.
- **Fallbacks:** if Jev is unsure (confidence below `minConfidence`, default 0.5), the API errors, the call times out (`timeoutMs`, default 4000), or no key is set, the default model is kept. A Jev failure never blocks a spawn.

## Install

At the prompt of a terminal session:

```
/plugin install jev-router --marketplace Bender-88/jev-router
```

Answer `y` to add the marketplace, then choose a scope. From a shell:

```
claude plugin install jev-router --marketplace Bender-88/jev-router
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `Bender-88/jev-router`, then Add plugin.

## Setup: your TypeSafe API key

You need your own TypeSafe API key. The mod reads it from the `TYPESAFE_API_KEY` environment variable. Never commit or share your key.

Add this line to `~/.zshrc`, replacing the placeholder with your key:

```
export TYPESAFE_API_KEY="<your-typesafe-api-key>"
```

Then start Claude from a terminal in which the variable is set (for example `open -a Claude` on macOS after quitting the app). An app launched from the Dock does not read `~/.zshrc`, so it will not see the key and the mod will do nothing.

You can instead fill in the `apiKey` option in the mod's config. If both are set, the config option wins.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | empty | TypeSafe API key; falls back to `TYPESAFE_API_KEY` |
| `trivialModel` | `haiku` | Model for trivial tasks |
| `standardModel` | `sonnet` | Model for standard tasks |
| `hardModel` | `opus` | Model for hard tasks |
| `minConfidence` | `0.5` | Below this Jev confidence, the default model is kept |
| `timeoutMs` | `4000` | Give up on Jev after this many milliseconds |
| `showMain` | `true` | Show Jev's suggestion in the pink band for main prompts |
| `switchMain` | `true` | Run main turns on Jev's pick when that is expected to cost less than staying |
| `downgradeOnly` | `true` | Never switch the main conversation to a pricier model than the session's |
| `cacheTtlMinutes` | `5` | How long a model keeps the conversation cached after its last request; used to weigh a switch |
| `prices` | `{"haiku":[1,5],"sonnet":[3,15],"opus":[5,25]}` | JSON of `[input, output]` USD per million tokens per model family, used for the savings estimate. The defaults are estimates; check current pricing |

## How it works

Each task is sent to `POST https://api.typesafe.ai/v1/systemone` as one Choice question over the model `jev-latest`. The task text (the subagent's description and prompt, or your prompt) is sent to TypeSafe, so do not use the mod where that is not acceptable.

## Develop

```
claude plugin validate .
claude plugin test .
```

## License

MIT
