# Implementation status

Tracks execution of `requirement/08-IPD-Implementation-Plan.md`. The requirement
package remains unchanged and authoritative.

Last updated: 2026-11-08.

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

- Phase 2: profile/facts API+UI, manual job import, canonicalization/deduplication, filter UI.
- Phase 3: AI provider adapter, scoring/rubric, CV/cover generation, PDF checks, screening Q&A, tracker.
- Phase 4: portal login/session, preflight snapshots, approvals, quota reservations, dispatch intent, evidence/reconciliation, recovery holds API.
- Phase 5/6: additional adapters, schedules UI, notifications, Gmail/Notion.

## Known gaps / follow-ups

- `tasks` and `outbox_events` still need owner-scoping review noted during
  requirement study (worker always receives `owner_id`, but the tables do not
  enforce it structurally beyond FK on `tasks`).
- AI budget ledger is not modelled; budget remains a future preference.
- No owner password-recovery flow (CLI only), as specified for the pilot but
  operationally incomplete.
- Cross-owner tests use a directly inserted second user; production provisioning
  still enforces single owner.
