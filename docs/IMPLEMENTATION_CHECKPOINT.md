# MemeLoop implementation checkpoint

This file is the durable resume point for the multi-repository implementation.
It exists so context compaction does not turn completed work back into pending
work. Update it when a gate changes state; do not reconstruct progress from chat
history alone.

## Resume rules

1. Treat phases and green gates below as monotonic. Re-run a green gate only
   when files in its dependency scope changed after the recorded evidence.
2. Before acting after a resume, compare the repository HEAD, dirty paths, and
   the relevant gate. Do not repeat branch inventories, PR-comment inventories,
   or broad review scans without a new upstream change.
3. A failed or rate-limited sub-agent does not erase its filesystem edits. Inspect
   the delta first; do not automatically re-delegate the same task.
4. Use the isolated Cloud worktree. Never reconcile against the concurrently
   edited original Cloud checkout by overwriting either tree.
5. Advance from the first incomplete item in "Current delta". Historical notes
   are evidence, not a new task list.
6. Do not start another broad audit or add another audit agent. The repository
   scanners now define the universal review rules. Consolidate the existing
   deltas, make each repository green once, commit, and move forward.
7. The orchestration-incident audit is closed. Do not read the thread again to
   reconfirm it, do not restate its statistics, and do not treat a context
   compaction as permission to replay any completed review or gate.

## Current continuation — 2026-09-08

Latest gate update: Desktop prompt-audit failure is fixed by acquiring the
independent `promptPreview` BrowserWindow. The exact named scenario passed all
20 steps in 12.285 seconds. Core follow-up `14089e3` is pushed; candidate tarball
is `memeloop-release-artifacts/react-ui-0.2.1-timeline-fix-20260908-14089e3/`
`memeloop-react-ui-0.2.1.tgz`, SHA-256
`10f437d6af094edd403c25cc7870819644a5e6dbb3d00546923539cd6cd69887`.
Installation into Desktop and validate:push both passed. Fresh packaging with
the follow-up succeeded at 08:43:51 UTC. Both calibration runs passed 14
scenarios / 408 steps each; the measured-timeout long-conversation scenario
then passed 20 steps in 12.282s. Desktop full unit command passed. Core CI run
34205833720 passed in 9m29s. Those process handles are now terminal; do not
restart them. Candidate clean install/export verification passed and is
recorded beside the tarball in VERIFICATION.md. This archive is ready for
manual npm publication. Desktop infrastructure/E2E changes are committed as
c6c797c1; preference assertion changes await the focused ComfyUI contract
coverage check. Registry manifests remain temporarily local and uncommitted.

- Continue only the Desktop packaged E2E gate. Previously green Cloud, Mobile,
  App and Core aggregate gates remain complete; no new broad review is needed.
- Core PR #2 received `a116872` via SSH push. React UI 0.2.1 is a local candidate,
  not yet approved for publication. A follow-up regression exposed a second
  recenter after host loading changes; manual browsing now survives those
  renders until selection or active-message/timeline identity changes.
  Its 42 long-conversation tests, changed-file ESLint and package build/export
  checks pass. Repack this follow-up before testing or publishing it.
- Desktop fresh packaged long-conversation run on September 8 completed 18
  steps, including timeline seeks and old-message rendering. It failed at
  `I open the generated model-request prompt audit` (300000 ms); the final
  request-content assertion was skipped. The sole delegated Desktop task is
  `desktop_prompt_audit`, investigating this exact failure.
- Desktop preference scenario already passed all 42 steps in the prior run.
  Desktop package.json/lock currently use a local React UI tarball; restore
  registry dependencies before committing those manifests.
- Next: fix the prompt-audit failure, install the follow-up UI tarball, run the
  targeted scenario, then complete calibration/CI and release evidence. Do not
  interpret the historical reconciliation tables below as new pending tasks.

## Active reconciliation batch — 2026-09-03

This is the only active batch after the incident audit. Each task has one
repository owner and one aggregate-gate objective; a resumed root agent must
wait for or reconcile these exact tasks instead of creating replacements.

| Task                  | Repository                     | Scope                                                               |
| --------------------- | ------------------------------ | ------------------------------------------------------------------- |
| `cloud_final_gate`    | isolated Cloud review worktree | Cloud server lint, full test, build; exact red-light fixes only     |
| `core_cli_final_gate` | Core review worktree           | Core/CLI final lint, type, test, build and review-contract gates    |
| `desktop_final_gate`  | TidGi Desktop canonical branch | Desktop final type, zero-warning lint, unit and package/build gates |
| `mobile_final_gate`   | TidGi Mobile canonical branch  | Mobile final type/lint/Jest/storage and available build gates       |
| `app_final_gate`      | MemeLoop App canonical branch  | App final type/lint/test/build and existing contract scanners       |

All five tasks are forbidden from branch/PR/history inventories, broad review,
committing, pushing, or modifying another repository. Root owns evidence
recording, logical commits, pushes, PR updates and CI watching after the batch.

### Batch evidence

- `cloud_final_gate` — complete. In the isolated Cloud worktree,
  `pnpm --filter @memeloop/cloud-server lint`, the full package test suite and
  package build passed. Vitest reported 133 passed / 1 skipped files and 754
  passed / 2 skipped tests; CJS, ESM and declaration builds passed. The gate
  made no further file changes.
- Cloud's 69-path delta was then committed as nine reviewable changes on the
  isolated branch and rebased onto current `origin/feat/private-relay-server`
  without force-pushing. A recovery ref named
  `backup/cloud-review-pre-rebase-20260903` preserves the exact pre-rebase
  state. Remote payment/image changes crossed the local Nacos/schema/image
  refactors, so `cloud_post_rebase_gate` is the sole active Cloud task; its
  purpose is conflict-integration validation, not a repeat of the earlier gate.
- `desktop_final_gate` — source gate complete. `pnpm run validate:push` passed
  repository contracts, TypeScript and zero-warning ESLint; the full unit suite
  passed 21 files / 150 tests. Main, preload, renderer and plugin production
  Vite builds also passed after pinning the linked AI SDK's required
  `@ai-sdk/provider-utils` version. Electron Forge then reached native packaging
  and failed on an external toolchain download (`TypeError: fetch failed`), so
  the post-change native installer/E2E evidence must come from macOS/Windows CI;
  the source/unit gate is not to be rerun locally.
- `core_cli_final_gate` — complete. The aggregate root test and build passed:
  Core 1961/1961, libp2p 98/98 and CLI 619/619 tests (7 environment skips),
  plus all Core/CLI/package builds and the existing review/boundary/export/Zod
  contract gates. The final lint had zero errors and `git diff --check` passed.
  Do not run another Core/CLI aggregate gate unless commit preparation changes
  source behavior.
- Core's retained breaking contract changes require new release lines because
  the prior versions already exist in the public registry. Manifests are now
  `memeloop@0.3.0`, `@memeloop/libp2p@0.3.0`, `memeloop-cli@0.3.0`,
  `@memeloop/protocol@0.2.0` and `@memeloop/react-ui@0.2.0`. The post-version
  `pnpm check:packages` gate passed all five packed archives, including export,
  dependency and `workspace:` checks.
- Cloud PR #4 was pushed at `adba411`. Its server/package gate was green locally,
  but CI `build-test` exposed previously uncompiled `memeloop-admin` TypeScript
  errors against the current commerce APIs. The original Cloud post-rebase owner
  was resumed for this exact CI red light; do not start a second Cloud fix task
  or rerun the unrelated 761 cloud-server tests.
- `mobile_final_gate` — software gate complete. Check and lint passed with zero
  lint errors; Jest passed 34 suites / 212 tests plus the isolated SQLite runtime
  integration; E2E TypeScript passed; Android Expo export produced a 17.5 MiB
  HBC bundle. The gate fixed a real backward-page double reversal in long
  conversation storage and corrected Metro/runtime dependency resolution.
  Physical-device E2E remains open because this host has no `adb`; it was not
  replaced with a mock.

## Orchestration incident audit

The thread record confirms an orchestration loop after the 2026-08-31 17:08
(Asia/Shanghai) review instruction:

- The first review turn ran 15.86 hours with 12 context compactions and 247
  sub-agent events. It completed and pushed the Core review work and green Core
  CI, and produced Desktop/External commits.
- The following repository-wide review turn ran 40.76 hours with 10 context
  compactions, 53 distinct sub-agent threads, 771 sub-agent events, and no final
  response.
- After multiple compactions the same broad Core/Desktop/Cloud/App/Mobile audit
  was announced and delegated again under different task names. Green milestones
  were not frozen before more edits were admitted into the same worktrees.

This was an orchestration failure, not evidence that the earlier implementation
did not happen. The corrective rule is consolidation only: no new broad audit,
no replay after compaction, and one final aggregate gate per repository after
its existing delta stops changing.

## Reconciliation freeze — 2026-09-03

The original thread, rather than a compaction summary, is authoritative for the
state before the loop. It records that an earlier convergence stage had already
reached all of the following milestones: review threads were at zero, Desktop
and Mobile CI were green, the Cloud Harbor digest was verified, final Windows
artifacts existed, and only visible-device/external-network acceptance evidence
remained. Later compactions incorrectly reactivated older repository-wide audit
items.

All remaining sub-agents were stopped after this was confirmed. Do not execute
the old delta list below as a task queue and do not assume the large dirty trees
are all new requirements. They are now evidence to reconcile.

Current remote/local facts at the freeze:

- Core PR #2 is at `7ec20ab918cc` with green CI; the detached review worktree is
  at that exact commit with 428 dirty paths accumulated after it.
- Desktop PR #743 is at `318796b7503c`; the local branch is three commits ahead
  at `3c433a5bb30d` and also has 217 dirty paths. Its displayed green CI belongs
  to the earlier remote head, not to the dirty review delta.
- The active goal had consumed 22,235,692 tokens and 284,857 seconds. This is an
  orchestration-loop signal, not an implementation progress metric.

The only permitted next workflow is:

1. Compare each dirty delta to its canonical remote PR head and classify paths
   as already-pushed duplicate, genuinely new review fix, or unrelated/unclear.
2. Preserve all existing files while doing that classification; do not reset or
   discard any dirty worktree.
3. Move only genuinely new review fixes into a clean, current-head integration
   worktree, run one proportional aggregate gate, commit, and push.
4. Do not invent a new package release/version solely because the loop produced
   local changes. Release only if a retained source fix changes a published
   package.

## Snapshot — 2026-09-03 (Asia/Shanghai)

| Repository            | Worktree / branch                                                                    | Base HEAD      | Dirty paths |
| --------------------- | ------------------------------------------------------------------------------------ | -------------- | ----------: |
| Core monorepo         | `memeloop-core-review-20260831` / detached, push target `feat/private-relay-rpc-e2e` | `7ec20ab918cc` |         425 |
| Desktop               | `TidGi-Desktop` / `feat/memeloop-0.1-integration`                                    | `3c433a5bb30d` |         198 |
| Mobile                | `TidGi-Mobile` / `feat/memeloop-0.1-mobile`                                          | `7a8ad19e5bd7` |          83 |
| Cloud                 | `memeloop-cloud-review-20260901` / `tmp/cloud-review-snapshot-20260901`              | `4535674d6df6` |          10 |
| App                   | `memeloop-app` / `feat/memeloop-0.2-app-integration`                                 | `01303f96fae3` |         182 |
| External orchestrator | `external-orchestrator` / `main`                                                     | `b78e06985b66` |          40 |

Dirty counts are descriptive only. These are accumulated implementation changes
owned by this plan and must not be discarded.

## Completed evidence — do not repeat without relevant changes

- Core framing v2, protocol-v2-only registration, stream abort semantics,
  coordinator, sync paging/state, signed pairing invites, long-conversation
  paging contracts, and shared UI work have already been implemented and tested
  during this plan. Their final aggregate gate remains pending because later
  public-contract refactors changed Core files.
- `@memeloop/libp2p`: 19 suites / 98 tests plus browser build and bundle passed.
- `@memeloop/protocol`: 4 test files / 7 tests plus build and declarations passed.
- `@memeloop/react-ui`: 232 tests, TypeScript, build, declarations, boundary and
  review-contract checks passed. Only final zero-warning lint is still required
  after any later UI changes.
- Desktop focused provider validation/i18n tests (26), External API settings and
  failure UI tests (35), and a subsequent repository TypeScript check passed.
- Desktop's production-contract scanner is already implemented with a
  comment/string-aware lexer, TypeScript-AST empty-catch detection, all-match
  source locations, and scanner self-tests. The earlier note claiming this was
  unfinished was stale compaction state.
- Mobile review-gate self-tests passed after it was hardened to reject
  comment-only catches, unsafe casts, allow-marker bypasses, and fixed E2E sleeps.
- Cloud strict immutable Nacos bundle/pointer/digest tests passed (18/18) in the
  isolated worktree.
- External orchestrator build/lint/tests passed against the local Core candidate:
  acceptance 19/19, worker 58/58, Kubernetes 50/50, Swarm 36/36 with one intended
  Docker skip. Registry-policy verification waits for the final Core release.
- Core PR #2 had no unresolved review threads at the last PR inventory. Do not
  fetch it again until new comments or a push require it.

## Universal review rules being enforced

- Public behavior must be implemented and tested, not merely declared.
- One canonical Core type/state/security/RPC/JSON contract; no host DTO mirrors
  or conversion layers.
- No old-field migration or compatibility fallback for this pre-release reset.
- No silent catch, comment-only catch, fake success, fixed-sleep fake-green test,
  unbounded read/cache/stream, unsafe cast, or platform-specific lifecycle leak.
- User-facing failures are localized and actionable; security/configuration
  writes fail closed and surface errors.
- Large roots are decomposed behind explicit extension/plugin contracts.

## Superseded loop-era delta — historical only, do not resume here

1. **Complete — Core library / active CLI delta (2026-09-03):** current `memeloop` build passed;
   `check:review-contracts` passed across 507 production files; provider routing
   already uses bounded canonical JSON; the remaining text-protocol/schema/TUI
   findings were corrected; 19 affected Core tool tests and 6 CLI TUI tests
   passed. A downstream local-link declaration build then exposed one CLI
   `getTurnDetail` path still returning full `ChatMessage` rows. It now projects
   bounded `ConversationMessageListProjection` rows; the CLI declaration build
   and its 2 SQLite RPC adapter tests pass. This CLI production edit requires
   only the final aggregate CLI gate, not another Core library audit. The first
   Desktop integration gate then exposed one precise Core defect: native provider
   tool calls with empty assistant text were incorrectly skipped by the plugin
   response hook. The hook now consumes the canonical call list independently of
   text; its new regression plus the focused Core tool/loop gates pass (58 tests),
   and the Core build passes.
2. **Complete — Desktop production delta; final aggregate pending (2026-09-03):** removed storage-key-to-ID,
   portable-config-ID, and path-to-main-workspace fallbacks; creation/editing now
   use `mainWikiSelection` and persisted hierarchy uses only `mainWikiID`.
   The scanner prevents their return and passed across 602 production files;
   its 4 self-tests, 43 affected tests, TypeScript, and full zero-warning lint
   passed. Desktop's two old text-tag tool integration fixtures now emit native
   provider tool calls; `multiTurnToolUse` (3) and `allToolsIntegration` (9) pass
   against the rebuilt local Core. Do not run the aggregate unit/package gate
   until Desktop stops changing, and then run it once.
3. **In progress — Mobile:** non-storage chat/execution/attachment adapters now
   use current projections, execution-target values and canonical parts. Their
   4 focused suites / 26 tests pass. The remaining compile delta is isolated to the storage adapter
   migration, which has one precise owner; do not re-open the broader Mobile
   audit.
4. App: finish canonical Core prompt/provider type adoption and remove legacy
   account migration. Run canonical-contract scanners and affected tests.
5. Cloud: finish the single-current-schema reset and reconcile LLM proxy tests
   with the real streaming/backpressure/abort/billing contract. Use only the
   isolated Cloud worktree.
6. After these deltas are green, run each repository's final aggregate gates,
   prepare the 0.3 package set, update registry dependencies after the user's
   npm 2FA publication, push canonical branches, watch CI, and append auditable
   evidence to `AGENT_ORCHESTRATION_PLAN.md`.

## Known external evidence still pending

- Two independent-NAT relay/DCUtR evidence.
- Android and iOS physical-device pairing/sync evidence.
- Sleep/network-switch/relay-renewal dogfood evidence.
- Harbor image digest and final Windows installer/startup evidence.

These remain incomplete until observed; mocks do not close them.
