# Ni Airlines · AI travel planner

Signing in or starting a new trip shows the profile city as **Suggested departure
city · Awaiting confirmation**, and asks whether to use it. It becomes a departure
choice only after confirmation; multi-airport cities still require an airport
choice. Unconfirmed suggestions are never used for flight searches, and explicit
trip input takes priority. This prefills a static demo profile, not learned memory.

A local-first, bilingual travel-planning demonstration with four business agents,
synthetic flights and fares, fictional member profiles, and optional Azure voice
integrations. **Ni Airlines is a fictional demo brand, not an official airline
service.** The supplied logo identifies this demonstration.

## Current status

The package is **1.0.8**. The member/brand candidate is locally active on port 3100
as build **`8d4e200885a2695f`**, from an isolated source-and-assets snapshot outside
the Team-Ni worktree. This repository
does not yet provide an Azure-hosted website. Azure hosting and restricted Entra
access are being prepared through separate approval gates. Persistent cross-trip
memory and cross-session spending governance remain deferred.

The conversation-first layout puts agent progress, **Member preferences** and **Current trip**
in a desktop sidebar, or a collapsible bottom section on narrow/short screens.
Only existing server-projected trip details and member preferences are displayed;
**Long-term memory not enabled** remains explicit. Voice controls are compact,
settings expand on demand, and resized panels cannot squeeze the message history
to a sliver. At matched 1366×768, 2000×1177 and 390×844 browser viewports with
voice open, the readable history grew from 102→306, 511→715 and 40→380 CSS pixels.
Short/mobile layouts scroll the page so both history and controls remain usable.
Refresh the page and sign in again after the snapshot restart.

The compact member card shows catalog-backed preferences, not learned memory.
Home city is labeled **Profile city · Confirm before using as departure**; Alex
has no default cabin. The profile city confirmation is bound to the current
session and trip version. Signing out or changing accounts clears it; starting
a new trip generates a new confirmation. Authenticated text searches use the same existing member
ranking as the managed voice path. An **Applied preferences** note appears beside
flight results only after at least two offers were actually ranked, with the
exact comparator explanation shown once. Evidence is bound to the current
member, trip, meeting blocks and offer IDs; guest, single-offer and unranked
results have no applied note. Explicit cabin choices remain unchanged.

The prior stable **1.0.8 / `111621bc136e5766`** runtime is stopped and retained
for rollback. The active runtime uses business versions **8/8/8/6**
(intent/planner/flight/price) and managed voice **Chinese v8 / English v9**;
Ni-brand business versions 9/9/9/7 remain inactive. Availability is local to
that machine, not a hosted service. Activation did not modify `.env`, replace
worktree `public` assets, commit, push, or run additional paid inference.

**Resolved local flow-control gap:** the previous build stopped a managed microphone session
at its unchanged 12,288-byte pending SDK-send limit. The fifth-mode browser did
not negotiate input acknowledgements, so it could send a fourth 4,096-byte packet
while three were pending. A local fix reuses the bounded capture/ACK policy from
mode 1, with ACK only after SDK send completion (not a service decode receipt),
explicit delayed-input feedback and ACK timeout. Offline bridge and browser
regressions pass. The user-approved full snapshot restart installed the fix as
build **`6ebc077834ab7c2e`**, but a subsequent human test hit an ACK timeout.

**Latest ACK investigation:** the single authorized Chinese diagnostic reproduced
the timeout after 534 completed SDK sends. All 534 server ACK callbacks completed,
and the browser received the same 2,187,264-byte offset. This was not an outstanding
SDK send or a missing ACK for those packets. Offline CPU profiling also recorded
multi-second synchronous module-resolution filesystem calls. A real-browser/SDK
regression reproduced the same queue/ACK pattern by delaying the business
identity resolver for three seconds. Identity loading now occurs at startup, the
managed bridge shares its authenticated server credential with the business
backend, and the smoke harness no longer imports the business module during capture.
The same regression passes without changing the 12,288-byte cap or two-second
timeout. The full fix is installed as **`5a38aad2c69665f2`**.

The paid diagnostic stopped on its first error; no paid retry was made. It did
not collect a CPU stack for the actual pause, so the exact filesystem call behind
that live pause remains unconfirmed. The user subsequently reported
“i have test the voice, should works” for `5a38aad2c69665f2`; mode, language and
duration were not supplied. The layout update keeps that voice protocol unchanged
and makes no additional paid calls. Diagnostic, prior member and stable runtimes
are retained for rollback.

The fifth, managed Foundry voice mode has **passed bounded synthetic Chinese v8
and English v9 member-aware flight-search round trips**, using real managed voice
and real Foundry **intent v8 / flight v8** business agents. Each turn delivered
trusted member preferences to both business agents, returned two synthetic
TPE→NRT economy offers for November 12, 2026, ranked them by the value persona
(TWD 8,900 then 9,100), and completed audio: **1,226,400 bytes Chinese /
865,200 bytes English**. No booking or payment occurred. Planner/price roles,
inactive Ni-brand business versions 9/9/9/7, human microphone/ASR quality and
production traffic were not validated by these targeted runs.

The user-approved architecture uses **only the final ASR associated with the same
committed audio item** as backend input. The strict `travel_backend` call is a
processing trigger; its model-written `message` is never input, instructions,
consent or a fallback. Equality flags are diagnostics only, not validation of ASR
quality. Function/schema/count/response ownership, final-item binding, deduplication,
serialization, member isolation and read-only transaction guards remain enforced.
Missing or failed final transcription cannot dispatch. Runtime `session.update`
sends only `{type: 'realtime'}` and checks the immutable effective settings.
The user-reported microphone result above is separate from the bounded,
instrumented synthetic checks.

The separate port-3101 four-language candidate has offline conversation-language
switching and fake-service voice-bridge coverage. Its cloud voice entry remains
disabled, pending approval of new business/voice versions, mappings and a bounded
paid validation. Acoustic language identification and real Japanese/Korean voice
have not been verified. This candidate is separate from the bilingual main runtime;
it does not activate four-language voice on port 3100. Its source remains outside
this repository and is not included in this commit. Persistent memory remains
separately deferred.

English follow-ups now recognise bounded spelling aliases such as `seach`,
`encomcy` and `persion`, without rewriting the original message or relaxing
transaction consent. A flight request asks for the next missing airport/date
instead of repeating discovery. “Give me suggest” or “give me recommendations”
continues itinerary planning. A full English `from ... to ...` route takes
precedence over a pending short airport-choice answer.

## Requirements and offline setup

- Node.js **22 or later** and npm.
- A modern browser. A microphone and an approved Azure configuration are needed
  only for a real voice session.
- Windows PowerShell examples below; no frontend bundler is required.

```powershell
git clone https://github.com/punmeng/travel-agent-with-voice-live.git
Set-Location travel-agent-with-voice-live
npm ci
Copy-Item .env.example .env
npm start
```

Open **http://127.0.0.1:3100**. The example uses `APP_MODE=mock`, keeps paid voice
integrations disabled, and needs no Azure credentials. If reusing an existing
checkout, inspect your own ignored `.env` first: `APP_MODE=foundry` and enabled
voice services can incur charges. Never copy credentials into browser code.

`npm start` serves `public`, the prior UI baseline. The complete bilingual
member/brand UI is preserved separately in `staging\member-public`; installing
these files into an existing application is a separate activation step.
For an **isolated offline member-candidate preview** instead:

```powershell
$env:APP_MODE = 'mock'
$env:PORT = '3101'
$env:ENGLISH_UI_CANDIDATE_DIR = Join-Path $PWD 'staging\member-public'
node tests\browser\candidate-server.js
```

Open **http://127.0.0.1:3101** and stop with Ctrl+C. This preview does not load
`.env`, enable Azure, or replace `public`. Do not run it while the browser test
runner needs the same port.

## Try a conversation

Select **English** or **繁體中文**. Start with an idea, such as “I would like a
five-day trip to Japan with less walking.” Add a departure city, explicit dates
including the year, adult count, and cabin when searching for flights. Dates must
be within the generated dataset window; inspect `data\network.json` rather than
assuming current live inventory.

The workflow is:
**Discover → Plan → Search → Compare → Select → Reprice → simulated checkout**.
Business choices use chat, not purchase cards. English examples after a matching
search are `select flight 1`, `reprice`, and, only after reviewing the displayed
current quote, `confirm current quote`.

The server owns trip state, offer expiry, quote versions, total/currency, consent,
and idempotency. A changed or expired quote invalidates consent. The checkout link
is a **simulation: no booking, ticket issuance, payment, passport or card data**.
Hotels, ancillaries, real supplier inventory, and real payment are outside scope.
Offline understanding supports bounded phrases; arbitrary natural-language
understanding requires separately configured Foundry agents.

## Fictional demo members

The candidate sign-in dialog lists five **local-only demo accounts**, using the
shared public demo password `MeihaoDemo!2026`. These are test fixtures, not real
people or production credentials; never reuse this password.

| Demo email | Persona |
|---|---|
| `alex.taipei@example.test` | Business |
| `tomo.tokyo@example.test` | Family |
| `ohsung.seoul@example.test` | Value |
| `adam.sydney@example.test` | Premium |
| `felix.singapore@example.test` | Business, advisory corporate guidance |

Salted password hashes and synthetic profiles are in `data\member-*.json`.
Identity is resolved server-side from the authenticated session, not supplied by
an agent. Preferences are soft ranking hints; explicit trip choices win.
Corporate guidance grants no approval or booking authority. Changing accounts or
logging out requires confirmation before clearing an active journey and rotates
the session. Restart, expiry, or a new trip clears in-memory journey state;
cross-trip memory has not been implemented.

Offline tests demonstrate different rankings for the same offers: value favors
the cheapest, family daytime departures, and premium convenient arrivals. Live
member context delivery and value-persona flight ranking through the fifth voice
path are verified in bounded synthetic zh/en turns with real intent/flight agents.
Other persona differences have offline coverage; human microphone acceptance remains pending.

## Architecture

The app uses native Node HTTP, ES modules, browser JavaScript, WebSockets, Zod
schemas, and an optional stdio MCP server. Four bounded roles share authoritative
server-side state:

| Business agent | Responsibility |
|---|---|
| `intent` | Extract request evidence, clarify missing details, route the turn |
| `planner` | Build an itinerary from saved preferences and approved knowledge |
| `flight` | Search and compare synthetic flight inventory through allowed tools |
| `price` | Retrieve/reprice offers; transactions remain server-controlled |

Mock mode uses deterministic local handlers. Foundry mode references four
configured agents; model text cannot overwrite flight prices or authorize
transactions. Planner guidance and approved website knowledge are explicit
inputs, not unrestricted crawling. Errors surface with a correlation ID;
cloud failure does not silently become mock success.

### Data and MCP

`data\network.json` contains manually curated airport/timezone references and
**synthetic** routes, schedules, flight numbers, cabins, availability and fares.
It is not a complete or current airline network. Unsupported cabins return no
results. The deterministic generator preserves dates, local timezones, overnight
arrivals, referential integrity and TWD totals.

```powershell
npm run generate
npm run export:tools
npm run mcp
```

Generation replaces generated synthetic data; it makes no cloud call. MCP uses
stdio, not a public HTTP endpoint, with strict `list_airports`,
`resolve_city_airports`, `search_flights`, `get_offer`, and `reprice_offer` tools.
Web and Foundry paths reuse the same `callTool` handlers, entitlements and budgets.
Outputs carry mock labels and correlation IDs. There is no MCP purchase tool.
Static knowledge and executable fare tools are kept separate.

Some static knowledge labels retain the legacy demo brand. Candidate preparation
has not rewritten or re-ingested cloud knowledge; these labels are not evidence
of a real airline's inventory.

## Voice integrations

All modes use the same travel backend. They are separate architectures, not four
voice names. Missing configuration is shown explicitly; no browser STT/TTS is
presented as Azure Voice Live.

| Mode | Path and boundary |
|---|---|
| 1 `voice-live` | Azure Speech transcription through Voice Live → four business agents → exact-text Voice Live speech; retains transaction guards |
| 2 `voice-realtime` | Voice Live `gpt-realtime-2.1` → controlled backend delegation → voice output; read-only transactions |
| 3 `gpt-live` | Separate `gpt-live-1` API → client delegation → backend → native audio; read-only transactions |
| 4 `speech-direct` | Speech REST short audio or continuous Speech SDK → backend → REST SSML speech; no Voice Live call; read-only transactions |
| 5 `foundry-voice-agent` | **Locally active candidate; synthetic zh/en round trips passed:** managed voice → strict tool trigger → same-item final ASR → existing member-aware backend → managed audio; transactions denied |

The first four have implementation and historical local integration evidence,
not a blanket claim of equivalent acoustic quality or current live availability.
Human microphone, accent, barge-in and room-acoustics acceptance remain separate.
Personal/custom voices require explicitly approved assets; identifiers stay
server-side. Stop/mute, cleanup, input/output limits, bounded queues and explicit
errors are preserved.

### Candidate versions and configuration mapping

The Ni-brand business-agent candidates are **intent 9 / planner 9 / flight 9 /
price 7**, not activated. Managed voice uses locale-pinned **zh-TW v8 / en-US v9**,
branched from v6/v7 with only echo reference `client→server` and channels `2→1`.
Both retain `gpt-realtime-2.1`, fixed locale instructions, multilingual VAD, strict
backend tools and `store=false`. v8/v9 now have synthetic audio ingress, same-item
ASR backend delivery, authenticated member context, ranked synthetic flight offers,
real intent v8 / flight v8 usage, tool result and output-audio evidence. These
checks do not validate inactive brand versions 9/9/9/7 or planner/price execution.
No further cloud version was created for the local ASR-authority change.

Version numbers describe this candidate lineage, not portable deployment IDs.
Runtime references come from server-side environment configuration and optional
locally generated, ignored mappings bound to the exact project, agent names and
source versions. A voice ticket freezes locale and resolves its exact approved
version. Matching incomplete mappings fail closed; an unrelated project keeps
its own configured references.

Deployment mappings, endpoint hashes, service traces and release manifests are
**not committed**. Creation/migration scripts are guarded maintenance tools,
not setup commands for a fresh clone. Never run cloud `--apply` scripts merely
to launch mock mode. See the [Foundry integration guide](docs/FOUNDRY.md).

## Validation and contribution safety

```powershell
npm run check
npm run check:mapping-voice
npm test
# If the runner reports a missing browser, install the approved browser once:
# npx playwright install chromium
$env:ENGLISH_UI_CANDIDATE_DIR = Join-Path $PWD 'staging\member-public'
# Keep the active 3100/3101 runtimes isolated. Override if 3102 is occupied.
$env:UI_TEST_PORT = '3102'
npm run test:ui
```

Node tests cover routing, dataset/tool contracts, search limits, quotes/consent,
idempotency, language, member ranking/identity isolation, and injected voice
transports. Browser tests use an isolated mock server on 3102 by default, refuse
to reuse an occupied port, and can use another port through `UI_TEST_PORT`.
Offline tests do not establish real microphone quality.
The complete Node suite passed **303/303**, and the complete isolated member
browser suite passed **103/103** for this release. Latest relevant voice/member/Foundry/routing/
transaction regressions passed **126/126**; the separately authorized synthetic
real-backend zh/en runs described above passed with role usage, member context,
ranked offers and output audio. The long-search fix preserves explicit search
intent when full dates and airport names exceed the old short phrase window.
Earlier preparation: syntax checks and 95 focused tests passed. The full Node run
passed 267/268; the Python workbook-reader timeout passed on an isolated 7/7
recheck. Browser coverage passed 72/78 initially, followed by 6/6 after correcting
legacy selectors for member-login fields and the hidden fifth-mode option.
Commands containing `test:voice:live`, `test:member-voice:live`, `deploy`,
`ingest`, or cloud `--apply` can incur charges or mutate cloud state and require
separate authorization.

The app binds to loopback and uses origin checks, CSP, HttpOnly/SameSite cookies,
strict allowlists, session limits and bounded parallelism. Demo sign-in is not
public production identity. **Do not expose it through a public host or tunnel.**
Sessions and quotes live in memory. Keep `.env`, `.foundry`, generated mappings,
raw logs, recordings, tokens and support evidence out of commits.

Further guides, primarily in Traditional Chinese:
[system design](docs/SYSTEM-DESIGN.md),
[Foundry and voice configuration](docs/FOUNDRY.md),
[demo script](docs/DEMO-SCRIPT.md),
[voice comparison](docs/VOICE-COMPARISON.md), and
[version history and current blockers](docs/CURRENT-VERSION.md).
