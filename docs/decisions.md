# Engineering decisions (implementation log)

The requirement package in `../requirement/` is the source of truth and is
**read-only**. This file records only how the implementation applies the
proposals from `requirement/14-Decision-Register.md` until the owner confirms
them. Confirmed decisions must be recorded here with a date and reason; the
requirement documents are not edited.

Status legend: **assumed** = used because the plan needs a concrete default;
**pending** = not needed yet or blocking a later phase.

| ID | Implementation status | Value used now | Note |
|---|---|---|---|
| DEC-01 | assumed | Single owner per installation, `owner_id` everywhere | `installation_owner` singleton + CLI provisioning |
| DEC-02 | assumed (provisional) | Next.js 16 + React 19 + TypeScript, Node worker, PostgreSQL, Docker Compose | Webpack bundler is pinned in scripts because Turbopack cannot create junctions on exFAT |
| DEC-03 | assumed (provisional) | Implementation lives in this repository, alongside `requirement/` | Repository visibility/license still unconfirmed |
| DEC-04 | assumed for P0 | No live portal adapter yet; manual import path is implemented (Phase 2) | Live adapters keep `enabled = false`; `manual` source is the only enabled source |
| DEC-05 | pending (provisional implementation) | Local snapshot/approval window defaults to 30 minutes and is configurable | `SUBMISSION_SNAPSHOT_TTL_MINUTES`; final policy and live portal approval rules remain unconfirmed |
| DEC-06 | provisional implementation | Local rule-based evaluator uses the proposal weights 30/25/15/30 under `local-rule-v1-proposal`; unknown dimensions keep the total score null | Owner confirmation and UAT-11 are still pending; this is not a confirmed product decision |
| DEC-07 | assumed | P0 manual submission, browser automation disabled, schedules disabled | `submission_controls.browser_enabled = false` by default |
| DEC-08 | assumed | Export TTL 24 h, backup retention 30 days, export read requires matching privacy generation | All values configurable via env |
| DEC-09 | assumed for P0 | No provider configured by default; one OpenAI-compatible provider can be configured and tested; secrets encrypted with AES-256-GCM using `MASTER_KEY` | Exact HTTPS endpoint allowlist; fallback stays off. Additional native adapters are later work. |
| DEC-10 | assumed | No automatic reapply/withdraw | State machine only allows explicit commands |
| DEC-11 | assumed | No cookie-sync extension | Not implemented |
| DEC-12 | assumed | Schedules/notifications P1; Gmail/Notion P2 | Tables exist, no handlers yet |
| DEC-13 | pending | Per-adapter evidence rules not defined | Blocks Phase 4 |
| DEC-14 | assumed for P0 | Local text template and dependency-free PDF compiler; immutable application document versions | Verified facts only, owner review before manual submission; visual/ATS acceptance still needs UAT |
| DEC-15 | assumed for P0 | Only explicitly selected verified facts plus the saved posting are sent for an AI job review | A separate explicit confirmation is required for each request; the model has no submit authority |
| DEC-16 | pending | First adapter capability not selected | Blocks Phase 4 |

## Invariants taken from the requirement package

Phase 4 fixture slice (2026-11-10): `local-dummy-v1` is an internal synthetic
form only. It proves snapshot binding, owner approval, and dry-run persistence;
it does **not** select an external portal, validate portal permissions, or
enable browser sessions/dispatch. `fixture:job:<id>` is not a verified live
target identity. DEC-16 and DEC-13 remain pending.

Submission policy UI/API (2026-11-10): the owner may store a quota timezone and
global/per-source limits in preparation for a later adapter. The settings API
does not enable browser submission. Internal quota services now reserve at
approval, revalidate the approved snapshot/current policy at dispatch intent,
and release reservations on cancellation before intent. They are not wired to
browser-attempt creation or portal dispatch. Browser enablement remains forced
off until DEC-16, DEC-13, and live dispatch implementation are complete.

- `submitted_confirmed` requires evidence (BR-12); unknown outcomes never retry
  automatically (BR-13). The queue refuses to auto-retry non-safe task kinds
  after a lease expires.
- No owner can be created over HTTP (BR-01).
- Secrets are write-only; audit/log payloads are scrubbed.
- Privacy generation invalidates old exports and blocks stale worker output.
- Data deletion closes access immediately and purges asynchronously.

## Environment notes

- The project currently lives on an exFAT volume. exFAT does not support
  junctions or `readlink` on regular files, so Turbopack and webpack tracing
  fail there. Builds are verified on NTFS; scripts use `next build --webpack`.
- `embedded-postgres` is used for tests and optional local development. It is
  a real PostgreSQL 18 cluster, not a mock.
