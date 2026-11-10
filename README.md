# AI Job Search Assistant (AJSA)

Self-hosted, single-owner job search workspace. The product specification lives
in [`requirement/`](./requirement) and is treated as **read-only source of truth**;
implementation decisions and their status are tracked in
[`docs/decisions.md`](./docs/decisions.md).

Current implementation: **Phase 0–3 P0** (private foundation, profile/manual job
search, evidence-linked ranking, consented AI review, versioned CV/cover PDFs,
application-specific screening answers, and manual application tracking) — see
[`docs/implementation-status.md`](./docs/implementation-status.md).

## What works today

- Local-only owner provisioning (CLI, singleton lock; the web app cannot create
  an owner).
- Login/logout with scrypt password hashes, HttpOnly session cookies, CSRF
  tokens and Origin checks, DB-backed login throttling.
- Versioned PostgreSQL schema covering identity, profile/facts, documents, jobs
  and listings, applications/attempts, quota, schedules, privacy and audit.
- Private document storage: content-based type validation, random object names,
  0600 files under a private directory, hash verification on download.
- Idempotent async commands (`Idempotency-Key`): replay, `409` on payload
  mismatch, `202` + operation reference while in progress.
- PostgreSQL-backed worker queue with `FOR UPDATE SKIP LOCKED`, lease tokens
  (fencing), heartbeat, retry/backoff, graceful shutdown, and an expired-lease
  sweep that refuses to auto-retry potentially external tasks.
- Privacy exports (ZIP + manifest, including evaluation history, 24 h default
  TTL), document purge with fact retraction, workspace reset that revokes
  exports via privacy generation,
  disables browser submission and opens a global recovery hold.
- Candidate profile with optimistic versioning and versioned facts
  (`unverified`, `verified`, `retracted`), including private source documents.
- Manual job import (`owner_paste` provenance), canonical URL validation without
  fetching, stable listing identity, revision history, deduplication suggestions,
  bookmark/archive curation and local text filters.
- P0 application tracker: create one draft per job, keep submission status
  separate from recruitment stage, record owner-reported manual submissions with
  an idempotency key, optimistic versions, timeline events and no worker/quota
  side effects.
- Encrypted screening answer bank with optimistic versions, verified/unverified/
  retracted states, source-fact links, and deterministic suggestions. Sensitive,
  legal or unknown questions always return `needs_user_input` instead of a guess.
- Versioned local job evaluations compare verified skills/facts and explicit
  profile preferences with a saved posting revision. Dimensions and hard filters
  show evidence, gaps, and unknowns; incomplete dimensions keep the total score
  null and require review. Scores are heuristic match measures, not hiring odds.
- Optional OpenAI-compatible provider configured from the dashboard. Its API key
  is encrypted and never returned; HTTPS endpoint origins are restricted by
  `AI_ALLOWED_ENDPOINT_ORIGINS`. A connection test sends a fixed prompt only.
- AI job review is a separate advisory flow: each run requires explicit consent
  and selected verified profile facts; only those facts and the saved posting are
  sent. Output must cite supplied fact versions and exact posting excerpts, is
  shown as a draft for owner review, and has no application-submit capability.
- Per-application CV and cover-letter drafts use selected verified facts, retain
  fact-version provenance, support immutable revisions and owner review, and
  produce private PDFs with local text-layer, structure and page-layout checks.
- Application-scoped screening answer drafts and immutable history are encrypted
  at rest and linked to source fact versions. Sensitive or unknown questions
  require owner input; suggestions are copied/reviewed manually and never
  auto-filled into a portal.
- Minimal accessible dashboard + login page, profile/fact editor, job import and
  filtering/ranking UI, evaluation details, application tracker UI, and health
  endpoints.

Not built yet: portal automation, approvals, quota enforcement, schedules UI,
notifications, and native Gemini/Anthropic adapters. The local CV/cover template
is intentionally plain text; visual/ATS acceptance and live end-to-end UAT still
need owner sign-off. See the phase table in
`docs/implementation-status.md`.

## Stack

Next.js 16 (App Router, React 19, TypeScript) · Node worker · PostgreSQL 18 ·
private local volume (S3-compatible later) · Docker Compose for homelab
deployment. No Redis dependency.

## Quick start (Docker Compose)

```bash
cp .env.example .env
# Generate real secrets:
node -e "console.log('MASTER_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('base64'))"
# Edit .env: set POSTGRES_PASSWORD, APP_ORIGIN, MASTER_KEY, SESSION_SECRET.
# Use a URL-safe POSTGRES_PASSWORD (it is interpolated into DATABASE_URL).

docker compose up -d db
docker compose run --rm migrate
docker compose run --rm web npm run provision-owner -- \
  --email you@example.com --timezone Asia/Jakarta
docker compose up -d web worker
```

Open `http://localhost:3000`. The password prompt is interactive; for automation
set `AJSA_OWNER_PASSWORD` for the one-off command instead.

## Quick start (local Node, no Docker)

Requires Node 22+ and npm.

```bash
npm install
cp .env.example .env
# Fill DATABASE_URL, MASTER_KEY, SESSION_SECRET, STORAGE_DIR.

# Terminal 1 — real PostgreSQL 18 via embedded-postgres (dev only)
npm run dev:db

# Terminal 2
npm run migrate
AJSA_OWNER_PASSWORD='a-long-password' npm run provision-owner -- \
  --email you@example.com --timezone Asia/Jakarta
npm run dev        # http://localhost:3000

# Terminal 3
npm run worker
```

Secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string, limited (non-superuser) role |
| `APP_ORIGIN` | yes | Public dashboard origin; drives cookie `Secure` and Origin checks |
| `MASTER_KEY` | for secrets | 32 random bytes, base64; AES-256-GCM key for provider secrets/answers |
| `SESSION_SECRET` | production | 32+ chars; HMAC key for session token hashes |
| `STORAGE_DIR` | yes | Private volume for documents/exports |
| `SESSION_TTL_HOURS` | no | Default 168 |
| `EXPORT_TTL_HOURS` | no | Default 24 (proposal DEC-08) |
| `BACKUP_RETENTION_DAYS` | no | Default 30 (proposal DEC-08) |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_WINDOW_MINUTES` | no | Default 5 / 15 |
| `STORAGE_MAX_BYTES` | no | Default 10 MiB per upload |
| `AI_ALLOWED_ENDPOINT_ORIGINS` | no | Comma-separated exact HTTPS base URLs permitted for the OpenAI-compatible adapter; defaults to `https://api.openai.com/v1` |

## API surface (implemented)

| Area | Endpoint |
|---|---|
| Health | `GET /api/v1/health/live`, `GET /api/v1/health/ready` |
| Auth | `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/session` |
| Documents | `GET/POST /api/v1/documents`, `GET /api/v1/documents/{id}/download`, `DELETE /api/v1/documents/{id}` |
| Privacy | `POST /api/v1/privacy/exports`, `POST /api/v1/privacy/deletions`, `GET /api/v1/privacy/requests/{id}`, `GET /api/v1/privacy/requests/{id}/download` |
| Profile | `GET/PATCH /api/v1/profile`, `GET/POST /api/v1/profile/facts`, `PATCH /api/v1/profile/facts/{id}` |
| Jobs | `GET /api/v1/jobs`, `GET /api/v1/jobs/{id}`, `PATCH /api/v1/jobs/{id}`, `POST /api/v1/jobs/imports` |
| Evaluations | `GET/POST /api/v1/jobs/{id}/evaluations`, `GET /api/v1/jobs/{id}/evaluations/{evaluationId}` |
| AI provider/review | `GET/PUT/POST /api/v1/ai/provider`, `GET/POST /api/v1/jobs/{id}/ai-reviews` |
| Duplicates | `GET /api/v1/duplicate-suggestions`, `POST /api/v1/duplicate-suggestions/{id}/resolve` |
| Applications | `GET/POST /api/v1/applications`, `GET/PATCH /api/v1/applications/{id}` |
| Tracker | `POST /api/v1/applications/{id}/manual-submissions`, `PATCH /api/v1/applications/{id}/recruitment-stage`, `GET /api/v1/applications/{id}/events` |
| Answer bank | `GET/POST /api/v1/answer-bank`, `PATCH /api/v1/answer-bank/{id}`, `POST /api/v1/answer-bank/suggest` |
| Application drafts | `GET/POST /api/v1/applications/{id}/answers`, `GET/POST /api/v1/applications/{id}/documents`, `PATCH /api/v1/applications/{id}/documents/{versionId}`, `POST /api/v1/applications/{id}/documents/{versionId}/review` |
| Tasks | `GET /api/v1/tasks/{id}`, `POST /api/v1/tasks/{id}/cancel` |

All authenticated mutations require `x-csrf-token` (from login/session response)
and a same-origin `Origin`. Async commands require `Idempotency-Key`. Response
envelopes follow the requirement contract: `{ data, meta }` / `{ error }`.
The ranking endpoint remains synchronous and local-only; its provisional rubric
is independent of the optional AI review and remains subject to owner
confirmation. AI review never changes the ranking score.

### Local evaluation preferences

Preferences use arrays for phrase lists. For example:

```json
{
  "targetTitles": ["Backend Developer"],
  "preferredLocations": ["Jakarta"],
  "preferredWorkModes": ["hybrid", "remote"],
  "minimumSalary": { "amount": 15000000, "currency": "IDR" },
  "requiredSkills": ["Java", "PostgreSQL"],
  "excludeTerms": ["intern"],
  "excludedCompanies": ["Example Corp"],
  "excludedIndustries": ["bank"]
}
```

Only verified skill facts are used for the skill dimension and `requiredSkills`
filter; `requiredSkills` is a candidate-side must-have list checked against those
facts. `excludeTerms` scans the title, company, location, and saved description;
an absent term stays `unknown` because a pasted description may be incomplete.
An overlapping salary range also stays `unknown` until the lower bound meets
the minimum or the upper bound falls below it. A verified `work_experience` fact can provide
`{"totalYearsExperience": 5}` when the posting states a years requirement.
Industry filters remain `unknown` because the current implementation does not
research or infer company industries.

## Security posture

- Owner provisioning only through the local CLI; the HTTP process starts at login.
- Session tokens stored as hashes; cookies HttpOnly, SameSite=Lax, Secure on HTTPS.
- Secrets encrypted at rest with a master key that lives outside the database.
- Uploads validated by content, never executed, streamed only through authorized
  endpoints.
- Audit/log metadata scrubbed of secrets, cookies, CV text and answers.
- Queue refuses automatic retries for task kinds that may have external effects;
  expired leases fail into manual review.
- Readiness/liveness are terse; restrict them and the dashboard at the network
  layer (Tailscale/Cloudflare Access/reverse proxy). Do not expose directly to
  the internet.

## Tests

```bash
npm run typecheck
npm run lint
npm test          # unit + integration against a real embedded PostgreSQL 18
npm run build
```

Tests cover provisioning races, sessions/CSRF/origin, owner scoping,
idempotency replay/conflict, queue leasing/fencing/expiry, DST schedule slots,
document validation/purge, export generation/revocation, workspace reset,
audit redaction, provider secret handling and no-fallback behavior, consented AI
review grounding, document version/PDF checks, application answer history, and
Phase 3 export/reset coverage.

## Layout

```
src/app/            Next.js routes + login/dashboard UI
src/components/     Client components
src/lib/            Domain modules (auth, crypto, db, documents, http, privacy,
                    queue, schedule, storage)
src/worker/         Worker entry point and task handlers
db/migrations/      SQL schema (source of truth for data)
scripts/            migrate, provision-owner, dev-postgres
tests/              unit + integration suites, embedded PostgreSQL setup
requirement/        Product/technical specification (read-only)
docs/               Engineering decisions and implementation status
```

## Notes and constraints

- The checkout currently lives on an **exFAT** volume. exFAT does not support
  junctions/`readlink` for regular files, so Turbopack and webpack file tracing
  fail. Scripts therefore use `next dev/build --webpack`; builds were verified
  on an NTFS copy of the repository.
- `npm run dev:db` is a development convenience; pilots should use the Compose
  PostgreSQL service with backups.
- Requirement documents are never edited by implementation work. If a proposal
  (DEC-xx) is confirmed or changed, record it in `docs/decisions.md`.
