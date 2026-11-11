# Implementation status

Tracks execution of `requirement/08-IPD-Implementation-Plan.md`. The requirement
package remains unchanged and authoritative.

Last updated: 2026-11-11.

## Phase 0 — Discovery & integration

| Item | Status | Evidence |
|---|---|---|
| Repository and modular-monolith structure | Done | `src/lib/{auth,crypto,db,documents,http,privacy,queue,schedule,storage}`, `src/worker` |
| License/NOTICE inventory | Done (no upstream code copied) | `THIRD_PARTY_NOTICES.md` |
| Dependency/CI pipeline without secrets | Done | `.github/workflows/ci.yml` |
| Decision register updated | Engineering log created, owner confirmation pending | `docs/decisions.md` |
| Live source/adapter spike | Not started (blocked by DEC-04/DEC-16) | — |

## Phase 1 — Private foundation (E00–E03)

| Epic | Status | What exists |
|---|---|---|
| E00 Repository | Done | Strict TypeScript, ESLint flat config, Vitest, Next build, npm lockfile |
| E01 Security | Done for local single-owner recovery | Local provisioning and password-reset CLIs, singleton lock, scrypt password hashing, session cookies (HttpOnly/SameSite/Secure when HTTPS), CSRF + Origin checks, owner scoping, DB-backed login throttle, audit; password reset revokes active sessions |
| E02 Storage | Done | Versioned SQL migrations (full logical schema), private local storage with content-based validation, upload/download/delete, idempotency records, export ZIP with manifest, purge with privacy generation, workspace reset + recovery hold |
| E03 Queue | Done | Claim with `FOR UPDATE SKIP LOCKED`, lease + fencing token, heartbeat, retry/backoff, graceful shutdown, expired-lease sweep with safe-kind allowlist, scheduler slot resolution incl. DST rules |

Verification (local, 2026-11-08):

- `npm run typecheck` — pass
- `npm run lint` — pass
- `npm test` — 11 files / 62 tests pass, including a real embedded PostgreSQL 18 cluster
- `npm run build` — pass (verified on NTFS; see exFAT note in `docs/decisions.md`)
- Manual HTTP smoke: login, session, upload PDF, private download, idempotent
  export request, worker export, ZIP download, document purge, workspace reset,
  export revocation (410), login survives reset

## Phase 2 — Profile & search P0 (E04–E06)

| Epic | Status | What exists |
|---|---|---|
| E04 Profile | Done (manual + local CV extraction) | Lazy profile row per owner, optimistic `version`, timezone in `users`, versioned facts with `unverified/verified/retracted`, owner-confirmed verification, source document linkage, correction creates a new fact version and invalidates prior verification. PDF/DOCX/TXT text extraction is local, previewed by the owner, and imports only as unverified facts; scanned PDFs need manual entry. |
| E05 Sources | Done for manual path | `manual` source, `POST /jobs/imports` with required `Idempotency-Key`, provenance `owner_paste`, URL validation **without fetching**, stable external identity, revision history. Live adapters remain disabled (DEC-04/DEC-16). |
| E06 Job model | Done | Canonical URL normalization, normalized company/title/location, cross-source duplicate suggestions with manual merge/reject, merge conflict when both jobs have applications, bookmark/archive/ignore-reason curation with `version`, local text filter. |
| UI | Done | Dashboard sections for profile, facts, local CV extraction, manual import, duplicate review, job filter/bookmark/archive. |

Verification (local, 2026-11-09):

- `npm run typecheck` — pass
- `npm run lint` — pass
- `npm test` — 14 files / 80 tests pass, including the new profile/job integration
  suites against a real embedded PostgreSQL 18 cluster
- `npm run build` — not re-run on this checkout (exFAT `readlink` limitation,
  see `docs/decisions.md`); run on an NTFS copy before release

Requirement traceability (Phase 2):

| Requirement/UAT | Coverage |
|---|---|
| AC-02 / UAT-03 | `tests/integration/profile.test.ts` (profile version conflict, stale update rejected) |
| AC-02 / UAT-04 | Versioned fact correction, unverified after edit, verify/retract, source document retained |
| AC-03 / UAT-06 | Manual import stores provenance, optional validated URL, no server-side fetch; adapter partial-success path remains Phase 5 |
| AC-04 / UAT-07 | Same source + external identity does not duplicate a listing; re-ingest updates retrieval data |
| AC-04 / UAT-08 | Similar title/company across sources only creates a review suggestion, never an automatic merge |
| AC-04 / UAT-09 | Merge returns `MERGE_CONFLICT` when both jobs already have applications |
| BR-04 / BR-05 | Normalization is pure and unit tested; list filters are explicit (`active`, `archived`, `all`) and `unknown` is not invented |

## Phase 3 — Evaluasi, dokumen & tracker P0 (E07–E09)

| Epic | Status | What exists |
|---|---|---|
| E09 Tracker | Done for P0 manual path | One draft application per job, owner notes with `current_version`, manual submission records (`mode=manual`, `state=submitted_confirmed`, `confirmation_source=manual`), target lock per job, separation from recruitment stage, timeline events, no worker task/quota consumption, deterministic conflict when a `submit_unknown` attempt exists, versioned cancellation, and reopen from `cancelled` to `draft` or `not_submitted` to `ready_for_review`. Reopen blocks when a matching target is unknown or already confirmed. Active-attempt cancellation checks intent and releases reserved quota. Submission records may attach only reviewed, latest document versions belonging to that application. |
| E08 Documents/Q&A | Done for P0 local path | CV/cover drafts use only explicitly selected verified facts, retain source fact-version IDs, support immutable edits and owner review, and generate private PDFs with text-layer, structure, page-count and layout checks. Application-scoped screening answers have encrypted content, immutable history and provenance; sensitive/unknown questions require owner input. No portal autofill. |
| E07 AI/evaluation | Done for P0 with owner review outstanding | Local evidence-based scoring remains deterministic and provisional; technical skill aliases are explicit and scoring evidence cites posting text. Dashboard-configured providers support fixed connection tests and separately consented job review using selected verified facts plus the saved posting. API keys are encrypted, write-only, endpoint origins are allowlisted, output is schema/evidence checked, and there is no fallback or submit authority. |
| E08 Interview preparation | Partial P1 | Per-application interview packs use selected verified facts and the saved posting after explicit provider-transfer consent. Fact IDs and exact posting excerpts are validated; unsupported answers remain for owner input. Stored content is encrypted and included in privacy exports. |
| E07 Company research | Partial P1 | Owner-provided source excerpts can be summarized after explicit provider-transfer consent. URLs are not fetched; supported claims must cite supplied sources and exact excerpts. |

Verification (Phase 3 update, 2026-11-10):

- Added integration coverage for provider-key encryption/redaction, consented
  model review and evidence validation, no-fallback behavior, document creation,
  edit/review/download/manual-submission version binding, and application answer
  snapshots. Added PDF structure/text/layout unit tests.
- Added privacy-export coverage for generated drafts and application answers;
  workspace reset coverage verifies the new Phase 3 rows and files are purged.
- `npm run typecheck` — pass.
- `npm run lint` — pass.
- `npm test` — 19 files / 107 tests pass, including embedded PostgreSQL Phase 3
  integration, privacy export/reset and local PDF checks.
- `npm run build` — pass with the production Webpack build.
- Rendered a representative one-page A4 PDF and verified it with `pdfinfo` and
  `pdftotext`; unsupported Unicode punctuation is normalized to readable ASCII.
- These checks establish implementation coverage; live provider credentials,
  owner acceptance of the plain-text layout and rubric, ATS compatibility, and
  owner UAT sign-off remain pending.
- At that point, a pilot backup-restore drill was not run because the checkout
  had no configured pilot database or PostgreSQL backup client. A synthetic
  isolated cold-copy drill was run later; see the Phase 4 follow-up below.
  Privacy export/reset behavior remains covered by integration tests.

Requirement traceability (Phase 3 slices):

| Requirement/UAT | Coverage |
|---|---|
| AC-11 / UAT-37 | Manual submission creates one terminal `manual` attempt, records the reported time and known document versions, and rejects duplicate reports or stale versions; Phase 3 tests bind submission to the latest reviewed document for that application |
| UAT-37 (unknown) | Existing `submit_unknown` attempt returns `SUBMIT_UNKNOWN_REQUIRES_RECONCILIATION` instead of overwriting history |
| UAT-23 | Recruitment stage changes create timeline events and never change submission status |
| BR-21 | No browser task and no quota row are created by manual reports |
| UAT-25 | Application list/detail/update/manual report all return `NOT_FOUND` for another owner |
| AC-08 / BR-09 | Answer bank: encrypted at rest, verified-only suggestions, unverified shown for review, sensitive/legal/unknown → `needs_user_input`, source facts displayed, answers absent from audit |
| UAT-24 (answer data) | Answer plaintext is not present in audit details or ciphertext; export decrypts only for the owner |
| AC-05 / UAT-10–12 | `src/lib/evaluations/scorer.ts` and `/jobs/{id}/evaluations` implement the provisional evidence-based rubric and unknown/veto handling; owner rubric confirmation and full UAT sign-off remain pending |
| AC-07 / UAT-13–14, UAT-51 | Local CV/cover template uses verified facts only, preserves source versions, and requires review; PDF checks fail closed on invalid text/layout/page limits. Generated claims are not model-invented. |
| AC-08 / UAT-15 | Application-specific answer snapshots preserve encrypted answer history and fact-version provenance; sensitive/unknown items require explicit owner input. No portal form is filled automatically. |
| AC-13 / UAT-24, UAT-53–54 | Provider settings are write-only for the key, connection test records selected model/status, AI review requires explicit transfer consent, and audit data excludes prompt/answer/key content; stubbed provider tests cover error/no-fallback paths. |
| AC-16 / UAT-39–41 | Export includes AI review metadata, decrypted application answer/document drafts and their versions, private PDFs, submission quota, recovery holds, and manual recovery evidence; provider keys stay excluded. Reset deletes related DB rows/artifacts and revokes exports. Restore/backup retention remains an operational UAT. |

## Phase 4 — Portal Assist P1 (safe preparation slices)

| Epic | Status | What exists |
|---|---|---|
| E10 Browser | Partial, local fixture plus JobStreet manual handoff | `local-dummy-v1` defines a synthetic form fingerprint. Preflight snapshots bind the application version, listing revision, latest documents, encrypted-answer hashes, and current verification state. A JobStreet reference can be opened only by an owner click, and a manual submission can retain an optional confirmation reference. No page fetch, browser profile, cookies, login, OTP/CAPTCHA handling, form fill, or network adapter exists. |
| E11 Submit | Partial, gated quota and lifecycle services | One active owner approval is version-bound and revalidated against current facts, documents, answers, and posting immediately before reservation and intent. Reservation atomically consumes approval, records global/source quota, and moves the application to `submitting`; intent rechecks current local-day limits and snapshot, then consumes quota. Pre-intent cancellation releases quota and revokes approval. Expired, revoked, stale, mismatched, disabled-adapter, or active-recovery-hold gates before intent now revoke the approval, release any active reservation, and move the attempt/application to `not_submitted`. Cancellation, intent, and manual recovery decisions serialize on the owner submission control. Owners can manually reconcile recovered attempts and release holds with recorded evidence and checklist attestations; unknown remains locked and post-intent quota stays consumed. Automated portal dispatch/evidence remains unimplemented. Dry-run remains `simulated`; browser enablement stays fail-closed. |

Verification (local, 2026-11-10):

- Unit coverage checks deterministic fixture fingerprint, readiness blockers,
  and fixture-only target identity.
- PostgreSQL integration coverage checks preflight/approval/dry-run, owner
  isolation, changed posting/facts, one active approval under a race, and zero
  task/quota side effects; unresolved attempts block preflight. Privacy export
  includes snapshots and approvals.
- `npm run typecheck` — pass.
- `npm run lint` — pass.
- Targeted fixture + submission + privacy tests — 3 files / 14 tests pass;
  submission-settings tests — 1 file / 5 tests pass.
- Recovery-hold visibility tests — 1 file / 2 tests pass.
- Quota reservation/intent/cancel tests — 1 file / 8 tests pass.
- Application lifecycle/cancel/reopen tests — 1 file / 11 tests pass.
- `npm test` — 24 files / 135 tests pass.
- `npm run build` — pass with the production Webpack build.
- Submission policy tests verify owner scope, optimistic versioning, audit, IANA
  timezone/limit validation, and rejection of browser activation before adapter qualification.
- These are local fixture and policy-configuration checks, not live portal UAT.
  JobStreet is selected only for manual handoff; automated access, dispatch,
  portal evidence, and reconciliation are not qualified.
- Phase 4 follow-up (2026-11-10): `npm run lint`, `npm run typecheck`, and
  `npm run build` pass after adding pre-intent cleanup for invalid approvals,
  disabled adapters, and active recovery holds. Regression tests now cover
  expired and revoked approvals before quota reservation and before dispatch
  intent, including terminal state, approval revocation, quota release, events,
  and audit. The focused quota suite passes (13 tests); the full suite passes
  (24 files / 140 tests), as do lint and typecheck.
- Phase 4 follow-up (2026-11-10): added a read-only-by-default post-restore
  guard CLI. With `--apply`, it disables browser submission, creates or
  conservatively widens a global recovery hold under the dispatch control lock,
  and records an operator audit event. The CLI cannot isolate the prior worker
  or browser session; real pilot backup and portal-history UAT remain open.
- Phase 4 follow-up (2026-11-10): added owner-only manual recovery actions for
  attempts and holds. `confirmed_sent` and `confirmed_not_sent` require
  outcome-specific checks and evidence references; `unknown` stays locked.
  Hold release checks active attempts, a complete review window, external
  activity and quota attestations, and records resolution metadata/audit.
  Browser submission remains disabled. Lint, typecheck, build, targeted quota
  and recovery suites, and the GitHub CI run pass.
- UAT-47 follow-up (2026-11-10): ran a synthetic cold-copy PostgreSQL restore
  drill in disposable data directories. It backed up a draft, created a
  post-checkpoint manual submission on the live copy, restored the old draft,
  verified the preview made no changes, applied and repeated the guard, and
  checked that the earliest checkpoint and unknown window end stayed
  conservative. A manual owner report reconciled the lost activity; guarded
  release retained browser-disabled state. No real portal or pilot backup was
  used, so UAT-47 remains partial; live portal history and quota evidence still
  need owner UAT. A PostgreSQL integration regression test also races dispatch
  intent against the post-restore CLI guard and verifies both valid serialized
  outcomes: intent commits before the guard, or the guard blocks intent and
  releases the pre-intent reservation. Live worker timing remains untested.

Requirement traceability (Phase 4 implemented slices):

| Requirement/UAT | Coverage |
|---|---|
| AC-10 / UAT-16 | Local dry-run stores `simulated`; fixture code has no browser/network dispatch, and integration test confirms zero task and quota rows. |
| AC-10 / UAT-18 | Approval binds the snapshot hash and current document/fact/posting state; mutations cause stale review and prevent dry-run. |
| BR-15 (partial) | Owner can save quota timezone and global/per-source limits. Internal services reserve and consume counters atomically, enforce limits at reservation and intent, handle local-midnight rollover, and release on pre-intent cancellation. Browser enablement remains rejected until adapter qualification. |
| UAT-41 (partial) | Active recovery holds block intent. Owners can record manual evidence, resolve a known attempt outcome, and release a hold only after the scope, coverage, quota, and external history checks pass. Portal evidence is not automatically validated; the actual pilot restore remains open. |
| UAT-47 (partial) | Post-restore guard disables browser submission and creates a global hold. A synthetic cold-copy restore drill verified read-only preview, guarded apply/reapply, recovery of a lost post-checkpoint manual submission, and release with browser submission still disabled. A PostgreSQL integration race test verifies dispatch intent serializes with guard application. Real portal history, pilot backup, quota evidence, and live worker timing remain for owner UAT. |
| BR-12 / UAT-37 (manual path) | A manual submission can store an optional owner-provided confirmation reference; it is not fetched or validated and the result remains labelled owner-reported/manual. |
| UAT-45–46 (partial) | Integration tests cover available/full quota at local midnight and same-day limit reductions before intent. Broader clock, timezone-change, and live worker scenarios remain untested. |
| UAT-50 (partial) | Cancellation and intent serialize on the owner control. Invalid approval or dispatch gate before intent terminates as `not_submitted` and releases quota. Regression coverage exercises expired and revoked approvals before reservation and before intent, including audit and quota accounting; portal outcomes after intent remain for owner UAT. |
| PR-15 / UAT-54 (partial) | Preflight and dry-run create owner audit events with IDs/counts and no answer/CV payloads. |
| UAT-19–22, UAT-28–30, UAT-42–44, UAT-48–49 | Not implemented: live dispatch lifecycle, portal race-stop and automated portal evidence, cross-listing target identity, and live restore-loss recovery. |

## Phase 5 — Perluasan P1 (provider, schedule, and notification slices)

| Epic | Status | What exists |
|---|---|---|
| E06 Saved searches | Done for local catalog | Owner-scoped saved-search create/read/update/delete API and dashboard controls to save, load, update, and delete query/status/source/sort filters. Changes are versioned and audited; searches can be scheduled against the local catalog. No source adapter is invoked by a scheduled run. |
| E12 AI providers | Partial | Dashboard-configured OpenAI-compatible, native Gemini `generateContent`, and Anthropic Messages adapters. All use a fixed JSON connection test, exact HTTPS base-URL allowlisting, encrypted write-only API keys in provider-specific headers, bounded responses/timeouts, usage-token reporting where available, and no automatic provider fallback. Switching provider/model invalidates the previous passing connection test. |
| Schedule and in-app notifications | Partial P1 | Owner-scoped schedule CRUD with optimistic versions, IANA timezone and DST slot resolution; worker materializes due runs, searches only the owner’s local indexed catalog, and stores run/listing history. New or revised listings after a baseline run appear in the dashboard inbox. No email, Telegram, or external source fetching is enabled. |

Verification for this slice:

- Integration tests use mocked provider responses to verify request paths, auth
  headers, JSON bodies, fixed-prompt tests, structured completion parsing, and
  token usage. No real provider credentials or candidate data are used.
- `npm run typecheck` and `npm run lint` pass; the focused provider integration
  suite passes for all three adapters. The saved-search integration and export
  coverage pass as part of the full suite (25 files, 144 tests).
- Live provider account/model compatibility and owner UAT remain unverified.
- For this implementation update, `npm run typecheck`, `npm run lint`, and
  `npm run build` pass.
  Automated tests were not run for this update; live provider/source behavior and
  owner UAT remain unverified.

## Requirement traceability (foundation)

These scenarios now have executable coverage; this is **not** a claim that UAT is
signed off by the owner.

| Requirement/UAT | Coverage |
|---|---|
| BR-01, UAT-01 | `tests/integration/provisioning.test.ts` (parallel provisioning, second attempt rejected) |
| UAT-02 | Session/CSRF/origin tests; unauthenticated API requests return 401 |
| UAT-25 | Owner scoping tests for documents and privacy requests |
| UAT-39 | Export manifest/content, excluded secrets, owner scope, generation revocation |
| UAT-40 | Document purge, `DOCUMENT_IN_USE`, fact retraction |
| UAT-41 | Reset purges data, disables browser submission, active global hold, artifact deletion |
| UAT-54 | Audit redaction test |
| BR-15 (foundation only) | Queue lease/fencing/safe-retry tests; gated quota reservation and intent accounting exist, but there is no browser-attempt creation or live worker dispatch |
| UAT-33/34/52 (foundation) | Schedule slot resolution tests: Jakarta, DST gap, repeated hour, late tolerance |

## Not started yet

- Phase 4 remaining: any authorized JobStreet interface (none qualified), live browser-attempt creation/worker dispatch, automated portal evidence validation, cross-listing target identity, pilot backup/portal restore verification, and owner live UAT. JobStreet manual handoff is available; quota and cancellation services remain internal gated foundations.
- Phase 5 remaining: qualified external source adapters, notifications outside the dashboard, and additional schedule/source UAT.
- Phase 6: Gmail/Notion and learning-plan integrations remain deferred pending owner decisions and privacy review.
- Live provider credentials, production deployment, and external ATS/client compatibility checks remain open.
- Owner confirmation of the proposed ranking rubric, live end-to-end/UAT sign-off, and restore drill against the actual pilot backup and portal history.

## Known gaps / follow-ups

- The task table requires an owner FK. Migration `0015` now also makes
  `outbox_events.owner_id` required and indexed; legacy null-owner events are
  scoped to the installation owner during upgrade. There is no outbox publisher
  yet, so event delivery/retry behavior remains open.
- AI budget ledger is not modelled; budget remains a future preference.
- Current evaluations are conservative string/rule comparisons. They can miss
  synonyms and context, and are not equivalent to the planned AI evaluator.
  Rubric weights, filter semantics, and UAT-11 results still need owner review;
  do not treat a shortlist label as a hiring recommendation.
- Duplicate detection only compares normalized company + title tokens. It is
  intentionally conservative and only proposes cross-source pairs; Phase 3
  ranking may add a stronger fingerprint.
- Scheduled searches currently compare the local catalog only; they do not
  fetch external sources. A first run establishes the notification baseline.
- Profile facts accept free-form JSON values; type-specific schemas can be added
  when extraction templates are defined.
- Manual submission uses `target_key = job:<id>`; cross-listing verification and
  reconciliation of `submit_unknown` remain Phase 4 work.
- Local Portal Assist uses `fixture:job:<id>` only for synthetic review records;
  never use it as a verified requisition key in a live adapter. Material freshness
  is rechecked when reading, approving, or running a fixture dry-run.
- The P0 CV/cover layout is a plain-text local template, not a branded design.
  PDF checks validate structure, text layer and page limits; visual rendering
  and ATS compatibility still require owner review on the target deployment.
- Gmail-based suggestions and notification channels outside the dashboard are
  not implemented.
- Answer-bank suggestions are deterministic; application-specific answer drafts
  are saved for manual copy/review and are never auto-filled into a portal.
- AI job review is a separate advisory draft, not part of the deterministic
  ranking score. It can be stale after profile or posting changes and never
  submits an application.
- Numeric/date checks are conservative safeguards, not full semantic entailment.
  Unstructured work-history prose and claims without explicit numeric/date
  signals can still need owner review. Regression tests and owner UAT for UAT-31
  and UAT-51 have not been run for this update.
- Cross-owner tests use a directly inserted second user; production provisioning
  still enforces single owner.

## Follow-up implementation (2026-11-11)

- Added `npm run reset-owner-password`, a local operator-only recovery flow.
  It uses the hidden prompt or `AJSA_OWNER_PASSWORD`, hashes with the existing
  scrypt scheme, revokes active sessions and records only safe metadata in audit.
- Migration `0015_owner_scoped_outbox.sql` makes outbox ownership mandatory and
  adds an owner/time index. Existing unowned events are assigned to the sole
  provisioned owner; migration stops safely if such events exist before owner
  provisioning.
- Interview preparation now blocks clearly reversed or conflicting structured
  work-history ranges before sending data to the AI provider. AI job review and
  interview preparation reject numeric/duration claims not present in selected
  verified facts. These checks do not replace owner review.
- `npm run typecheck`, `npm run lint`, and `npm run build` are local
  implementation checks for this update. Automated tests were not run;
  UAT-31/UAT-51 regression coverage and owner sign-off remain open.
