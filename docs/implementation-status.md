# Implementation status

Tracks execution of `requirement/08-IPD-Implementation-Plan.md`. The requirement
package remains unchanged and authoritative.

Last updated: 2026-11-09.

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
| E01 Security | Done | Local provisioning CLI with singleton lock, scrypt password hashing, session cookies (HttpOnly/SameSite/Secure when HTTPS), CSRF + Origin checks, owner scoping, DB-backed login throttle, audit |
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
| E04 Profile | Done (manual entry) | Lazy profile row per owner, optimistic `version`, timezone in `users`, versioned facts with `unverified/verified/retracted`, owner-confirmed verification, source document linkage, correction creates a new fact version and invalidates prior verification. |
| E05 Sources | Done for manual path | `manual` source, `POST /jobs/imports` with required `Idempotency-Key`, provenance `owner_paste`, URL validation **without fetching**, stable external identity, revision history. Live adapters remain disabled (DEC-04/DEC-16). |
| E06 Job model | Done | Canonical URL normalization, normalized company/title/location, cross-source duplicate suggestions with manual merge/reject, merge conflict when both jobs have applications, bookmark/archive/ignore-reason curation with `version`, local text filter. |
| UI | Done | Dashboard sections for profile, facts, manual import, duplicate review, job filter/bookmark/archive. |

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

## Phase 3 — Tracker & answer bank (E08–E09, partial)

| Epic | Status | What exists |
|---|---|---|
| E09 Tracker | Partial (P0 manual path) | One draft application per job, owner notes with `current_version`, manual submission records (`mode=manual`, `state=submitted_confirmed`, `confirmation_source=manual`), target lock per job, separation from recruitment stage, timeline events, no worker task/quota consumption, deterministic conflict when a `submit_unknown` attempt exists. |
| E08 Documents/Q&A | Partial (answer bank only) | Encrypted answer bank with owner notes, `version`, `unverified/verified/retracted`, source fact links, deterministic exact/near-question matching, and `needs_user_input` for sensitive/legal/unknown questions. No AI call and no form auto-fill yet. |
| E07 AI | Not started | Provider abstraction and scoring remain pending. |

Verification (local, 2026-11-09):

- `npm run typecheck` — pass
- `npm run lint` — pass
- `npx vitest run tests/integration/applications.test.ts tests/integration/answer-bank.test.ts` — 16 tests pass
- Full `npm test` — 17 files / 99 tests pass
- `npm run build` — still not run on this exFAT checkout

Requirement traceability (Phase 3 slices):

| Requirement/UAT | Coverage |
|---|---|
| AC-11 / UAT-37 | Manual submission creates one terminal `manual` attempt, records the reported time and known document versions, and rejects duplicate reports or stale versions |
| UAT-37 (unknown) | Existing `submit_unknown` attempt returns `SUBMIT_UNKNOWN_REQUIRES_RECONCILIATION` instead of overwriting history |
| UAT-23 | Recruitment stage changes create timeline events and never change submission status |
| BR-21 | No browser task and no quota row are created by manual reports |
| UAT-25 | Application list/detail/update/manual report all return `NOT_FOUND` for another owner |
| AC-08 / BR-09 | Answer bank: encrypted at rest, verified-only suggestions, unverified shown for review, sensitive/legal/unknown → `needs_user_input`, source facts displayed, answers absent from audit |
| UAT-24 (answer data) | Answer plaintext is not present in audit details or ciphertext; export decrypts only for the owner |

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
| BR-15 (foundation only) | Queue lease/fencing/safe-retry tests; quota tables exist but Phase 4 logic is not built |
| UAT-33/34/52 (foundation) | Schedule slot resolution tests: Jakarta, DST gap, repeated hour, late tolerance |

## Not started yet

- Phase 3 remainder: AI provider adapter, scoring/rubric, CV/cover generation, PDF checks, and wiring answers into application forms.
- Phase 4: portal login/session, preflight snapshots, approvals, quota reservations, dispatch intent, evidence/reconciliation, recovery holds API.
- Phase 5/6: additional adapters, schedules UI, notifications, Gmail/Notion.

## Known gaps / follow-ups

- `tasks` and `outbox_events` still need owner-scoping review noted during
  requirement study (worker always receives `owner_id`, but the tables do not
  enforce it structurally beyond FK on `tasks`).
- AI budget ledger is not modelled; budget remains a future preference.
- Duplicate detection only compares normalized company + title tokens. It is
  intentionally conservative and only proposes cross-source pairs; Phase 3
  ranking may add a stronger fingerprint.
- `saved_searches` exists but there is no saved-search UI or schedule wiring yet.
- Profile facts accept free-form JSON values; type-specific schemas can be added
  when extraction templates are defined.
- Manual submission uses `target_key = job:<id>`; cross-listing verification and
  reconciliation of `submit_unknown` remain Phase 4 work.
- `document_versions` can be recorded on a manual submission only when those
  versions already exist; generation/PDF versioning is still Phase 3 remainder.
- Application cancellation/reopen and Gmail-based suggestions are not implemented.
- Answer suggestions are deterministic; there is no AI provider or form auto-fill
  yet. Near-question matching is conservative and never bypasses sensitive checks.
- Answer bank edits reset verification, but application answers are not yet
  snapshotted or linked to a specific application.
- No owner password-recovery flow (CLI only), as specified for the pilot but
  operationally incomplete.
- Cross-owner tests use a directly inserted second user; production provisioning
  still enforces single owner.
