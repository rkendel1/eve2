# eve remaining Vercel gaps

Ordered by value to a non-Vercel user. Each one that needs new public API should start as a `research/` plan, per the repository's rules.

## Mandatory or blocking

1. **Multi-agent workspaces build only Vercel output.** `internal/vercel/build-agent-workspace.ts` always writes `.vercel/output` with a Vercel services config. An `agents/` workspace therefore cannot be self-hosted as one Node server. _Next step:_ a node-server workspace build that mounts each agent under its prefix. Not executed in this audit.
2. **Deployed self-modification is Vercel-only.** `self-modification/deployed-sandbox.ts` throws off-Vercel. This is a niche feature.

## Vercel or no default off-Vercel (working explicit alternative exists)

3. **Model string IDs route to AI Gateway**, and the implicit default model with no `agent.ts`, `openai/gpt-6-luna-fast`, is a gateway string. A plain `eve init` without `--model` still scaffolds a gateway string. _Options:_
   - (a) Have non-interactive `eve init` choose `openai-api/…` or `anthropic-api/…` when only that provider's key is present and no gateway credential exists. This inference runs at scaffold time but produces explicit code.
   - (b) Document `AI_SDK_DEFAULT_PROVIDER` as the supported global override.

   Not done, because both change product defaults; this needs an owner decision.

4. **`fileMemory()` throws off-Vercel without a backend.** A durable filesystem or Postgres backend default for `eve start` would remove a sharp edge. The error message is already actionable.
5. **Experimental dynamic schedules default to `vercelScheduleProvider()`**, which throws off-Vercel. A self-hosted provider is needed; the local world or Postgres could back it.
6. **The default sandbox depends on Docker being reachable at build time.** Without Docker, a production build has no sandbox. This is safe by design, but it surprises people who build in CI and run on a Docker host.
7. **The default route auth is `[vercelOidc(), localDev(), placeholderAuth()]`.** Self-hosted production rejects every caller until auth is configured. This is a secure default, but the only built-in production credential it accepts is Vercel-issued.
8. **The build fetches the model catalog from `ai-gateway.vercel.sh`.** Offline builds warn, and dynamic models then need `modelContextWindowTokens`.

## Optional or cosmetic

9. **`eve deploy` and `eve link` are Vercel-only by design.** The self-hosted equivalent is `eve build` + ship `.output/` + `eve start`. A `--target` flag or an `eve deploy` adapter interface is a possible follow-up. That is also where an AppBoundry adapter would plug in.
10. **The scaffold always adds Vercel-flavored defaults:**
    - the `@vercel/connect` dependency
    - `.vercelignore`
    - a `"deploy": "eve deploy"` script
    - README and AGENTS.md copy that assumes Vercel
    - "Vercel's agent framework" instructions copy

    The web channel also writes `vercel.json`. None of these fail off-Vercel.

11. **Gallery templates** (`apps/templates/*`): 8 have Vercel config, and 6 `.env.example` files reference gateway or OIDC variables.
12. **Root `package.json` description** says "on Vercel".

## Not verified

- An actual Vercel deployment (no account in this environment).
- The Postgres world. It is documented and supported by eve, but was not exercised here.
- Windows and macOS hosts. Only Linux was used.
- The e2e suites, which are CI-only per repository policy.

## Highest-value next steps

1. Decide on gap 3, the default model for providerless `eve init`. It is the largest remaining day-one Vercel dependency for new users.
2. Build a self-hosted workspace (gap 1).
3. Give `fileMemory` and dynamic schedules a durable non-Vercel default backed by the configured world (gaps 4 and 5).
4. Add a scenario test that runs `eve build` + `eve start` + one turn with Vercel variables scrubbed. It would encode this audit's manual verification so CI catches regressions.
