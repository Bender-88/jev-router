# jev-router

A Claude Code mod that uses [TypeSafe](https://typesafe.ai)'s Jev model to pick which Claude model each subagent runs on, based on the task it is given.

## What it does

- **Subagents:** before a subagent starts, Jev classifies its task as `trivial`, `standard` or `hard`. The mod sets the subagent's model to haiku, sonnet or opus accordingly.
- **Pink band above the prompt:** a rounded box in TypeSafe pink with a `◈ JEV` mark, Jev's latest decision (tier, model, confidence), the task with the route (for example `sonnet → haiku`), and an estimate of what routing saved, for the current prompt and for the whole session, for example `this prompt: saved ~$0.21 · session: saved ~$1.30`. Amounts show 2 decimals. It has a Hide button.
- **How savings are estimated:** when a routed subagent finishes, its tokens are priced at the model it ran on and at your session's own model, and the difference is the saving. Cache reads and writes are estimated at 10% and 125% of the input price. These are rough figures based on the `prices` option, not billing data, and they say nothing about answer quality. Forks are never routed, so they add no savings. Main-conversation turns are folded into the same totals as an estimate: their tokens are priced at the model they ran on and at the model Jev suggested for that prompt. The main model is not actually switched, so that part is what you could have saved, not money saved, and it assumes the cheaper model would use the same tokens.
- **Forks:** never routed. A fork always inherits its parent's model.
- **Explicit models:** a subagent that already names a model is left alone.
- **Main conversation:** the engine gives a mod no way to switch the main session's model, so the mod only shows Jev's suggestion in the pink band for each prompt. Turn this off with the `showMain` option.
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
