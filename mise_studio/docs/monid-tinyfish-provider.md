# Monid / TinyFish provider evidence

Verified September 18, 2026 against public, official sources. Runtime calls were not made because this workspace has neither `monid` nor `MONID_API_KEY` configured. No credential or paid call is needed for the deterministic tests.

## Verified contract

- Monid HTTP base URL is `https://api.monid.ai`; all `/v1/*` routes require `Authorization: Bearer <api-key>`. The launch page's “no API keys” copy conflicts with Monid's API overview and current `SKILL.md`, both of which require an account-generated API key. The integration therefore treats a key as required and does not expose it to browser code.
- Runs start with `POST /v1/run` and may return synchronously or with HTTP 202. Asynchronous work is read from `GET /v1/runs/:runId`. Current documented statuses are `READY`, `RUNNING`, `STOPPING`, `COMPLETED`, `FAILED`, `BLOCKED`, `STOPPED`, and `TIMED_OUT`.
- Official Monid connector source defines provider `tinyfish`, endpoint `/search`, method `GET`, upstream `https://api.search.tinyfish.ai/`, 15 second request timeout, and query-parameter input. The required search field is `query`; `domain_type` supports `web`, `news`, and `research_paper`. The provider injects `X-API-Key` upstream, while this app authenticates only to Monid.
- Official Monid connector source defines endpoint `/fetch`, method `POST`, upstream `https://api.fetch.tinyfish.ai/`, and JSON body input. It accepts 1–10 URLs and `markdown`, `html`, or `json`; this recipe adapter sends one selected URL and requests Markdown. Monid documents a 150 second request timeout and 165 second run timeout.
- A completed Monid run can still contain a provider error. `providerResponse.httpStatus` is checked independently from the run lifecycle status.

## Runtime behavior

`createRecipeProvider()` considers TinyFish only when `MONID_API_KEY` is present. Before each endpoint's first run, it calls the free Monid inspect API and requires the response to identify the requested TinyFish endpoint with both `price.amount` and any `price.flatFee` equal to zero. A missing, malformed, or nonzero price fails closed and no run is created. Without a key, existing Brave/open search and the protected HTML fetcher remain available. TinyFish calls are server-only, bounded by timeout and response-size limits, validate all returned URLs, poll only documented transient states, and map auth, rate-limit, malformed-output, timeout, blocked, and failed states to stable application errors.

TinyFish Fetch returns Markdown. The provider routes only labelled Ingredients and Instructions/Method sections through the existing normalized text extractor; prose, nutrition, comments, and other headings are excluded. It returns the standard `{ status, recipes, warnings }` extraction envelope.

## Sources

- Monid connector source pinned at commit `bd152f68e9f1f54eea132602fed49da90b6ab379`:
  - https://github.com/monid-ai/monid/blob/bd152f68e9f1f54eea132602fed49da90b6ab379/connectors/tinyfish/provider.ts
  - https://github.com/monid-ai/monid/blob/bd152f68e9f1f54eea132602fed49da90b6ab379/connectors/tinyfish/endpoints/search/endpoint.ts
  - https://github.com/monid-ai/monid/blob/bd152f68e9f1f54eea132602fed49da90b6ab379/connectors/tinyfish/endpoints/search/schema/inputs.ts
  - https://github.com/monid-ai/monid/blob/bd152f68e9f1f54eea132602fed49da90b6ab379/connectors/tinyfish/endpoints/fetch/endpoint.ts
  - https://github.com/monid-ai/monid/blob/bd152f68e9f1f54eea132602fed49da90b6ab379/connectors/tinyfish/endpoints/fetch/schema/inputs.ts
- Official TinyFish SDK usage confirming Search's `{ results: [...] }` response and Fetch document fields:
  - https://github.com/tinyfish-io/tinyfish-cookbook/blob/main/AABW_Vietnam_Hackathon_Samples/monai/app/services/tinyfish_client.py
  - https://github.com/tinyfish-io/tinyfish-cookbook/blob/main/skills/use-tinyfish/SKILL.md
- https://docs.monid.ai/api/run.html
- https://docs.monid.ai/api/runs.html
- https://docs.monid.ai/api/overview.html
- https://monid.ai/SKILL.md
- https://monid.ai/blog/tinyfish

## Live gate still open

A live `mapo tofu recipe` search and selected recipe Fetch remain unverified until a server-side Monid key is configured. The fallback must remain enabled until that gate passes. When a key is available, inspect `tinyfish /search` and `tinyfish /fetch` first, then run only those zero-price endpoints and record sanitized output shapes plus observed rate limits. Do not enable any automatic paid-provider escalation.
