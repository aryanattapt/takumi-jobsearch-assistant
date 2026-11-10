'use client';

import { useCallback, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export interface WorkspaceProfile {
  id: string;
  displayName: string | null;
  timezone: string;
  preferences: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceFact {
  id: string;
  type: string;
  value: unknown;
  verificationStatus: 'unverified' | 'verified' | 'retracted';
  sourceDocumentId: string | null;
  version: number | null;
  verifiedAt: string | null;
  versionCreatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceJob {
  id: string;
  status: string;
  bookmarked: boolean;
  ignoredReason: string | null;
  version: number;
  title: string;
  company: string;
  description: string;
  location: string | null;
  provenance: string | null;
  source: { code: string; name: string };
  listing: {
    id: string;
    externalId: string | null;
    canonicalUrl: string | null;
    postingStatus: string;
    retrievedAt: string;
    revisionId: string | null;
    count: number;
  };
  latestEvaluation: WorkspaceEvaluation | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceEvaluation {
  id: string;
  jobId?: string;
  evaluationVersion: number;
  profileVersion: number;
  postingRevisionId: string | null;
  rubricVersion: string;
  status: 'scored' | 'insufficient_data' | 'unreachable' | 'failed';
  score: number | null;
  decision: 'shortlist' | 'review' | 'excluded';
  dimensions: Array<{
    name: string;
    score: number | null;
    weight: number;
    reason: string;
    evidence: Array<{ kind: string; reference: string; excerpt?: string }>;
    gaps: string[];
  }>;
  hardFilters: Array<{
    name: string;
    state: 'pass' | 'fail' | 'unknown';
    reason: string;
  }>;
  matches: string[];
  gaps: string[];
  unknowns: string[];
  vetoes: string[];
  sourceRefs: Record<string, unknown>;
  model: string | null;
  createdAt: string | null;
  isCurrent?: boolean;
}

export interface WorkspaceDuplicate {
  id: string;
  confidence: number;
  reason: string;
  resolution: string;
  createdAt: string;
  left: {
    jobId: string;
    title: string;
    company: string;
    status: string;
    listingCount: number;
  };
  right: {
    jobId: string;
    title: string;
    company: string;
    status: string;
    listingCount: number;
  };
}

export interface WorkspaceDocumentOption {
  id: string;
  originalName: string;
  kind: string;
  status: string;
}

export interface WorkspaceAiReview {
  id: string;
  jobId: string;
  providerType: string;
  model: string;
  createdAt: string;
  profileVersion: number;
  factVersionIds: string[];
  result: {
    status: 'needs_review';
    summary: string;
    strengths: Array<{ claim: string; factVersionIds: string[]; postingEvidence: string }>;
    gaps: Array<{ description: string; postingEvidence: string }>;
    questions: string[];
  };
}

export interface JobSearchProps {
  csrfToken: string;
  profile: WorkspaceProfile;
  facts: WorkspaceFact[];
  jobs: WorkspaceJob[];
  duplicates: WorkspaceDuplicate[];
  documents: WorkspaceDocumentOption[];
  aiProviderReady: boolean;
  aiProviderModel: string | null;
  savedAiReviews: WorkspaceAiReview[];
}

interface ApiEnvelope<T> {
  data?: T;
  error?: { code?: string; message?: string };
}

async function callApi<T>(
  url: string,
  options: RequestInit & { csrf?: string; idempotencyKey?: string },
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.csrf) headers.set('x-csrf-token', options.csrf);
  if (options.idempotencyKey) headers.set('idempotency-key', options.idempotencyKey);
  const response = await fetch(url, { ...options, headers });
  const payload = (await response.json().catch(() => ({}))) as ApiEnvelope<T>;
  if (!response.ok || payload.error) {
    throw new Error(payload.error?.message ?? `Request failed (${response.status})`);
  }
  return payload.data as T;
}

const FACT_TYPE_LABELS: Record<string, string> = {
  contact: 'Kontak',
  location: 'Lokasi',
  education: 'Pendidikan',
  work_experience: 'Pengalaman kerja',
  skill: 'Skill',
  language: 'Bahasa',
  salary_expectation: 'Ekspektasi gaji',
  work_preference: 'Preferensi kerja',
  other: 'Lainnya',
};

const TIMEZONES = [
  'Asia/Jakarta',
  'Asia/Makassar',
  'Asia/Jayapura',
  'Asia/Singapore',
  'UTC',
];

function describeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function evaluationDecisionLabel(decision: WorkspaceEvaluation['decision']): string {
  if (decision === 'shortlist') return 'Shortlist awal';
  if (decision === 'excluded') return 'Tidak lolos filter';
  return 'Butuh pemeriksaan';
}

function dimensionLabel(name: string): string {
  const labels: Record<string, string> = {
    technical: 'Keahlian teknis',
    experience: 'Pengalaman',
    work_context: 'Konteks kerja',
    career_alignment: 'Arah karier',
  };
  return labels[name] ?? name;
}

export default function JobSearch(props: JobSearchProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState(props.profile.displayName ?? '');
  const [timezone, setTimezone] = useState(props.profile.timezone);
  const [preferences, setPreferences] = useState(
    JSON.stringify(props.profile.preferences ?? {}, null, 2),
  );

  const [factType, setFactType] = useState('skill');
  const [factValue, setFactValue] = useState('');
  const [factSource, setFactSource] = useState('');

  const [jobTitle, setJobTitle] = useState('');
  const [jobCompany, setJobCompany] = useState('');
  const [jobLocation, setJobLocation] = useState('');
  const [jobUrl, setJobUrl] = useState('');
  const [jobDescription, setJobDescription] = useState('');

  const [filterQuery, setFilterQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState('active');
  const [sortOrder, setSortOrder] = useState<'recent' | 'score'>('recent');
  const [jobs, setJobs] = useState(props.jobs);
  const [duplicates, setDuplicates] = useState(props.duplicates);
  const [selectedAiFactIds, setSelectedAiFactIds] = useState<string[]>([]);
  const [aiReviews, setAiReviews] = useState<Record<string, WorkspaceAiReview>>(
    Object.fromEntries(props.savedAiReviews.map((review) => [review.jobId, review])),
  );

  function evaluationIsCurrent(job: WorkspaceJob): boolean {
    const evaluation = job.latestEvaluation;
    return Boolean(
      evaluation &&
      evaluation.isCurrent !== false &&
      evaluation.profileVersion === props.profile.version &&
      evaluation.postingRevisionId === job.listing.revisionId,
    );
  }

  const orderedJobs = [...jobs].sort((left, right) => {
    if (sortOrder === 'recent') {
      return new Date(right.listing.retrievedAt).getTime() - new Date(left.listing.retrievedAt).getTime();
    }
    const decisionOrder: Record<WorkspaceEvaluation['decision'] | 'none', number> = {
      shortlist: 0,
      review: 1,
      excluded: 2,
      none: 3,
    };
    const leftEvaluation = left.latestEvaluation;
    const rightEvaluation = right.latestEvaluation;
    const leftRank = decisionOrder[leftEvaluation?.decision ?? 'none'];
    const rightRank = decisionOrder[rightEvaluation?.decision ?? 'none'];
    if (leftRank !== rightRank) return leftRank - rightRank;
    const scoreDiff = (rightEvaluation?.score ?? -1) - (leftEvaluation?.score ?? -1);
    if (scoreDiff !== 0) return scoreDiff;
    return new Date(right.listing.retrievedAt).getTime() - new Date(left.listing.retrievedAt).getTime();
  });

  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        await action();
        router.refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Action failed');
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  async function saveProfile(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    let parsedPreferences: Record<string, unknown>;
    try {
      const parsed = JSON.parse(preferences || '{}') as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setError('Preferensi harus berupa JSON object yang valid.');
        return;
      }
      parsedPreferences = parsed as Record<string, unknown>;
    } catch {
      setError('Preferensi harus berupa JSON object yang valid.');
      return;
    }
    await run(async () => {
      await callApi('/api/v1/profile', {
        method: 'PATCH',
        csrf: props.csrfToken,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: displayName.trim() === '' ? null : displayName.trim(),
          timezone,
          preferences: parsedPreferences,
          expectedVersion: props.profile.version,
        }),
      });
      setMessage('Profil tersimpan dengan versi baru.');
    });
  }

  async function addFact(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = factValue.trim();
    if (!trimmed) {
      setError('Nilai fakta tidak boleh kosong.');
      return;
    }
    let value: unknown = trimmed;
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
      try {
        value = JSON.parse(trimmed);
      } catch {
        setError('Nilai terlihat seperti JSON tetapi tidak valid.');
        return;
      }
    }
    await run(async () => {
      await callApi('/api/v1/profile/facts', {
        method: 'POST',
        csrf: props.csrfToken,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: factType,
          value,
          sourceDocumentId: factSource || null,
        }),
      });
      setFactValue('');
      setMessage('Fakta ditambahkan sebagai belum diverifikasi. Tinjau lalu verifikasi.');
    });
  }

  async function updateFact(
    fact: WorkspaceFact,
    body: Record<string, unknown>,
  ): Promise<void> {
    await run(async () => {
      await callApi(`/api/v1/profile/facts/${fact.id}`, {
        method: 'PATCH',
        csrf: props.csrfToken,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, expectedVersion: fact.version }),
      });
      setMessage('Fakta diperbarui dengan versi baru.');
    });
  }

  async function fetchJobs(): Promise<WorkspaceJob[]> {
    const params = new URLSearchParams({ status: filterStatus });
    if (filterQuery.trim()) params.set('q', filterQuery.trim());
    const result = await callApi<{ jobs: WorkspaceJob[] }>(
      `/api/v1/jobs?${params.toString()}`,
      { method: 'GET' },
    );
    return result.jobs;
  }

  async function fetchDuplicates(): Promise<WorkspaceDuplicate[]> {
    const result = await callApi<{ suggestions: WorkspaceDuplicate[] }>(
      '/api/v1/duplicate-suggestions',
      { method: 'GET' },
    );
    return result.suggestions;
  }

  async function editFact(fact: WorkspaceFact): Promise<void> {
    const next = window.prompt(
      'Nilai baru (teks atau JSON). Koreksi menyimpan versi baru dan mengembalikan status ke belum diverifikasi:',
      describeValue(fact.value),
    );
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) {
      setError('Nilai fakta tidak boleh kosong.');
      return;
    }
    let value: unknown = trimmed;
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
      try {
        value = JSON.parse(trimmed);
      } catch {
        setError('Nilai terlihat seperti JSON tetapi tidak valid.');
        return;
      }
    }
    await updateFact(fact, { value });
  }

  async function importJob(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await run(async () => {
      const result = await callApi<{
        import: { createdJob: boolean; duplicateSuggestionIds: string[] };
      }>('/api/v1/jobs/imports', {
        method: 'POST',
        csrf: props.csrfToken,
        idempotencyKey: crypto.randomUUID(),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: jobTitle,
          company: jobCompany,
          description: jobDescription,
          location: jobLocation || null,
          referenceUrl: jobUrl || null,
        }),
      });
      setJobTitle('');
      setJobCompany('');
      setJobLocation('');
      setJobUrl('');
      setJobDescription('');
      setJobs(await fetchJobs());
      setDuplicates(await fetchDuplicates());
      setMessage(
        result.import.createdJob
          ? result.import.duplicateSuggestionIds.length > 0
            ? 'Lowongan disimpan. Ada kandidat duplikat lintas sumber untuk ditinjau.'
            : 'Lowongan disimpan dengan label Dimasukkan pemilik.'
          : 'Lowongan sudah ada; data pengambilan diperbarui tanpa duplikat listing.',
      );
    });
  }

  async function loadJobs(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await run(async () => {
      const result = await fetchJobs();
      setJobs(result);
      setMessage(`${result.length} lowongan ditemukan.`);
    });
  }

  async function patchJob(
    job: WorkspaceJob,
    body: Record<string, unknown>,
  ): Promise<void> {
    await run(async () => {
      const updated = await callApi<WorkspaceJob>(`/api/v1/jobs/${job.id}`, {
        method: 'PATCH',
        csrf: props.csrfToken,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, expectedVersion: job.version }),
      });
      setJobs((current) =>
        current
          .map((item) => (item.id === updated.id ? updated : item))
          .filter((item) =>
            filterStatus === 'all' ? true : item.status === filterStatus,
          ),
      );
      setMessage('Lowongan diperbarui.');
    });
  }

  async function evaluateJob(job: WorkspaceJob): Promise<void> {
    await run(async () => {
      const evaluation = await callApi<WorkspaceEvaluation>(
        `/api/v1/jobs/${job.id}/evaluations`,
        {
          method: 'POST',
          csrf: props.csrfToken,
          idempotencyKey: crypto.randomUUID(),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expectedProfileVersion: props.profile.version,
            expectedPostingRevisionId: job.listing.revisionId,
          }),
        },
      );
      setJobs((current) => current.map((item) =>
        item.id === job.id ? { ...item, latestEvaluation: evaluation } : item,
      ));
      setMessage(
        evaluation.score === null
          ? 'Penilaian disimpan sebagai butuh pemeriksaan karena bukti belum cukup.'
          : `Skor kecocokan heuristik: ${evaluation.score.toFixed(1)} dari 100. Tinjau dimensi dan sumbernya.`,
      );
    });
  }

  async function reviewJobWithAi(job: WorkspaceJob): Promise<void> {
    const facts = props.facts.filter((fact) =>
      selectedAiFactIds.includes(fact.id) && fact.verificationStatus === 'verified',
    );
    if (!facts.length) {
      setError('Pilih minimal satu fakta terverifikasi di bagian persetujuan AI.');
      return;
    }
    const confirmed = window.confirm(
      `Kirim ${facts.length} fakta terverifikasi yang Anda pilih, serta judul, perusahaan, lokasi, dan deskripsi lowongan "${job.title}" ke ${props.aiProviderModel ?? 'provider AI'} untuk review? Fakta lain, catatan pribadi, dan API key tidak dikirim. Hasilnya tetap draf untuk ditinjau.`,
    );
    if (!confirmed) return;
    await run(async () => {
      const review = await callApi<WorkspaceAiReview>(
        `/api/v1/jobs/${job.id}/ai-reviews`,
        {
          method: 'POST',
          csrf: props.csrfToken,
          idempotencyKey: crypto.randomUUID(),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            factIds: facts.map((fact) => fact.id),
            confirmDataTransfer: true,
          }),
        },
      );
      setAiReviews((current) => ({ ...current, [job.id]: review }));
      setMessage(`Review AI dari ${review.model} tersimpan sebagai draf yang perlu ditinjau.`);
    });
  }

  async function archiveJob(job: WorkspaceJob): Promise<void> {
    const reason = window.prompt(
      `Arsipkan "${job.title}"? Tulis alasan (opsional) agar keputusan bisa ditinjau nanti:`,
      'Tidak sesuai preferensi',
    );
    if (reason === null) return;
    await patchJob(job, {
      status: 'archived',
      ignoredReason: reason.trim() === '' ? null : reason.trim(),
    });
  }

  async function resolveDuplicate(
    suggestion: WorkspaceDuplicate,
    resolution: 'merged' | 'rejected',
  ): Promise<void> {
    const confirmation =
      resolution === 'merged'
        ? window.confirm(
            'Gabungkan kedua job? Semua listing dipindah ke satu job canonical dan histori tetap disimpan. Merge ditolak bila keduanya sudah punya application.',
          )
        : true;
    if (!confirmation) return;
    await run(async () => {
      await callApi(`/api/v1/duplicate-suggestions/${suggestion.id}/resolve`, {
        method: 'POST',
        csrf: props.csrfToken,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolution }),
      });
      setDuplicates((current) => current.filter((item) => item.id !== suggestion.id));
      setJobs(await fetchJobs());
      setMessage(
        resolution === 'merged'
          ? 'Job digabung dan listing dipindahkan ke job canonical.'
          : 'Dugaan duplikat ditolak; kedua job tetap terpisah.',
      );
    });
  }

  return (
    <div>
      <div aria-live="polite">
        {message ? <p className="notice">{message}</p> : null}
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <section className="panel" aria-labelledby="profile-title">
        <h2 id="profile-title">Profil kandidat</h2>
        <p className="muted">
          Data profil adalah sumber fakta. Perubahan menaikkan versi; simpan dengan versi
          lama akan ditolak agar perubahan terbaru tidak tertimpa.
        </p>
        <form onSubmit={saveProfile}>
          <div className="grid">
            <div>
              <label htmlFor="profile-name">Nama tampilan</label>
              <input
                id="profile-name"
                type="text"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                maxLength={200}
              />
            </div>
            <div>
              <label htmlFor="profile-timezone">Timezone</label>
              <select
                id="profile-timezone"
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
              >
                {[...new Set([timezone, ...TIMEZONES])].map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <label htmlFor="profile-preferences">
              Preferensi (JSON: posisi, lokasi, work mode, industri dilarang, budget)
            </label>
            <textarea
              id="profile-preferences"
              rows={5}
              value={preferences}
              onChange={(event) => setPreferences(event.target.value)}
              spellCheck={false}
            />
            <p className="muted" style={{ fontSize: '0.8rem' }}>
              Kunci untuk penilaian: targetTitles, preferredLocations, preferredWorkModes,
              minimumSalary, requiredSkills, excludeTerms, excludedCompanies, dan
              excludedIndustries. Contoh: {`{"targetTitles":["Backend Developer"],"preferredLocations":["Jakarta"],"preferredWorkModes":["hybrid"]}`}
              . Industri tanpa data tetap berstatus perlu pemeriksaan.
            </p>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button type="submit" disabled={busy}>
              Simpan profil
            </button>
            <span className="muted">Versi saat ini: {props.profile.version}</span>
          </div>
        </form>
      </section>

      <section className="panel" aria-labelledby="facts-title">
        <h2 id="facts-title">Fakta profil</h2>
        <p className="muted">
          Fakta hasil ekstraksi atau input manual berstatus belum diverifikasi. Hanya fakta
          terverifikasi yang boleh dipakai sebagai klaim final. Koreksi menyimpan versi baru.
        </p>
        <form className="row" onSubmit={addFact} style={{ alignItems: 'flex-end' }}>
          <div>
            <label htmlFor="fact-type">Jenis</label>
            <select
              id="fact-type"
              value={factType}
              onChange={(event) => setFactType(event.target.value)}
            >
              {Object.entries(FACT_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 260 }}>
            <label htmlFor="fact-value">Nilai (teks atau JSON)</label>
            <textarea
              id="fact-value"
              rows={2}
              value={factValue}
              onChange={(event) => setFactValue(event.target.value)}
              placeholder={factType === 'work_experience'
                ? '{"totalYearsExperience":5}'
                : 'Skill, contoh: TypeScript'}
            />
          </div>
          <div>
            <label htmlFor="fact-source">Sumber dokumen</label>
            <select
              id="fact-source"
              value={factSource}
              onChange={(event) => setFactSource(event.target.value)}
            >
              <option value="">Tanpa dokumen</option>
              {props.documents
                .filter((document) => document.status === 'active')
                .map((document) => (
                  <option key={document.id} value={document.id}>
                    {document.originalName} ({document.kind})
                  </option>
                ))}
            </select>
          </div>
          <button type="submit" disabled={busy}>
            Tambah fakta
          </button>
        </form>

        {props.facts.length === 0 ? (
          <p className="muted" style={{ marginTop: 14 }}>
            Belum ada fakta profil.
          </p>
        ) : (
          <ul className="card-list" style={{ marginTop: 14 }}>
            {props.facts.map((fact) => (
              <li key={fact.id}>
                <div>
                  <strong>{FACT_TYPE_LABELS[fact.type] ?? fact.type}</strong>
                  <div className="muted" style={{ fontSize: '0.9rem' }}>
                    {describeValue(fact.value)}
                  </div>
                  <div className="muted" style={{ fontSize: '0.8rem' }}>
                    versi {fact.version ?? 0}
                    {fact.sourceDocumentId
                      ? ` · sumber ${fact.sourceDocumentId.slice(0, 8)}…`
                      : ' · tanpa sumber'}
                  </div>
                </div>
                <div className="row">
                  <span
                    className={`badge ${
                      fact.verificationStatus === 'verified'
                        ? 'ok'
                        : fact.verificationStatus === 'retracted'
                          ? 'bad'
                          : 'warn'
                    }`}
                  >
                    {fact.verificationStatus}
                  </span>
                  {fact.verificationStatus !== 'verified' ? (
                    <button
                      className="secondary"
                      onClick={() => updateFact(fact, { verificationStatus: 'verified' })}
                      disabled={busy}
                    >
                      Verifikasi
                    </button>
                  ) : null}
                  <button
                    className="secondary"
                    onClick={() => editFact(fact)}
                    disabled={busy}
                  >
                    Koreksi
                  </button>
                  {fact.verificationStatus !== 'retracted' ? (
                    <button
                      className="danger"
                      onClick={() => updateFact(fact, { verificationStatus: 'retracted' })}
                      disabled={busy}
                    >
                      Tarik
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="import-title">
        <h2 id="import-title">Tambah lowongan manual</h2>
        <p className="muted">
          Tempel detail lowongan dari grup, email, atau portal tanpa konektor. Sistem tidak
          mengambil URL secara otomatis; URL hanya disimpan sebagai rujukan setelah validasi.
        </p>
        <form onSubmit={importJob}>
          <div className="grid">
            <div>
              <label htmlFor="job-title">Judul posisi</label>
              <input
                id="job-title"
                type="text"
                value={jobTitle}
                onChange={(event) => setJobTitle(event.target.value)}
                required
                maxLength={300}
              />
            </div>
            <div>
              <label htmlFor="job-company">Perusahaan</label>
              <input
                id="job-company"
                type="text"
                value={jobCompany}
                onChange={(event) => setJobCompany(event.target.value)}
                required
                maxLength={300}
              />
            </div>
            <div>
              <label htmlFor="job-location">Lokasi</label>
              <input
                id="job-location"
                type="text"
                value={jobLocation}
                onChange={(event) => setJobLocation(event.target.value)}
                maxLength={300}
              />
            </div>
            <div>
              <label htmlFor="job-url">URL rujukan (opsional)</label>
              <input
                id="job-url"
                type="url"
                value={jobUrl}
                onChange={(event) => setJobUrl(event.target.value)}
                placeholder="https://..."
              />
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <label htmlFor="job-description">Deskripsi lowongan</label>
            <textarea
              id="job-description"
              rows={6}
              value={jobDescription}
              onChange={(event) => setJobDescription(event.target.value)}
              required
            />
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button type="submit" disabled={busy}>
              Simpan lowongan
            </button>
            <span className="muted">
              Disimpan dengan label Dimasukkan pemilik dan provenance owner_paste.
            </span>
          </div>
        </form>
      </section>

      {duplicates.length > 0 ? (
        <section className="panel" aria-labelledby="duplicates-title">
          <h2 id="duplicates-title">Dugaan duplikat lintas sumber</h2>
          <p className="muted">
            Kemiripan tidak digabung otomatis. Merge ditolak bila kedua job sudah punya
            application agar histori tidak hilang.
          </p>
          <ul className="card-list">
            {duplicates.map((suggestion) => (
              <li key={suggestion.id}>
                <div>
                  <strong>
                    {suggestion.left.title || '(tanpa judul)'} ↔{' '}
                    {suggestion.right.title || '(tanpa judul)'}
                  </strong>
                  <div className="muted" style={{ fontSize: '0.85rem' }}>
                    {suggestion.left.company} · {suggestion.left.listingCount} listing vs{' '}
                    {suggestion.right.listingCount} listing · confidence{' '}
                    {suggestion.confidence.toFixed(2)}
                  </div>
                  <div className="muted" style={{ fontSize: '0.8rem' }}>
                    {suggestion.reason}
                  </div>
                </div>
                <div className="row">
                  <button
                    onClick={() => resolveDuplicate(suggestion, 'merged')}
                    disabled={busy}
                  >
                    Gabung
                  </button>
                  <button
                    className="secondary"
                    onClick={() => resolveDuplicate(suggestion, 'rejected')}
                    disabled={busy}
                  >
                    Bukan duplikat
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="panel" aria-labelledby="jobs-title">
        <h2 id="jobs-title">Lowongan</h2>
        <details style={{ marginBottom: 14 }}>
          <summary>Persetujuan data untuk review AI</summary>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            Pilih fakta satu per satu. Hanya fakta berstatus terverifikasi yang dicentang,
            bersama detail lowongan yang dipilih saat tombol review ditekan, dikirim ke
            provider yang aktif. Hasil AI tidak mengubah skor lokal atau mengirim lamaran.
          </p>
          {props.facts.filter((fact) => fact.verificationStatus === 'verified').length === 0 ? (
            <p className="muted">Belum ada fakta terverifikasi.</p>
          ) : (
            <div className="grid">
              {props.facts
                .filter((fact) => fact.verificationStatus === 'verified')
                .map((fact) => (
                  <label key={fact.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <input
                      type="checkbox"
                      checked={selectedAiFactIds.includes(fact.id)}
                      onChange={(event) => setSelectedAiFactIds((current) => event.target.checked
                        ? [...new Set([...current, fact.id])]
                        : current.filter((id) => id !== fact.id))}
                    />
                    <span>{FACT_TYPE_LABELS[fact.type] ?? fact.type}: {describeValue(fact.value)}</span>
                  </label>
                ))}
            </div>
          )}
          <p className="muted" style={{ fontSize: '0.8rem' }}>
            Terpilih: {selectedAiFactIds.length} fakta. Provider: {props.aiProviderReady ? `${props.aiProviderModel} siap` : 'belum aktif atau belum lolos tes koneksi'}.
          </p>
        </details>
        <form className="row" onSubmit={loadJobs} style={{ alignItems: 'flex-end' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label htmlFor="job-filter">Cari judul, perusahaan, atau deskripsi</label>
            <input
              id="job-filter"
              type="text"
              value={filterQuery}
              onChange={(event) => setFilterQuery(event.target.value)}
              placeholder="Backend, Jakarta, ..."
            />
          </div>
          <div>
            <label htmlFor="job-status">Status</label>
            <select
              id="job-status"
              value={filterStatus}
              onChange={(event) => setFilterStatus(event.target.value)}
            >
              <option value="active">Aktif</option>
              <option value="archived">Diarsipkan</option>
              <option value="all">Semua</option>
            </select>
          </div>
          <div>
            <label htmlFor="job-sort">Urutkan</label>
            <select
              id="job-sort"
              value={sortOrder}
              onChange={(event) => setSortOrder(event.target.value as 'recent' | 'score')}
            >
              <option value="recent">Terbaru</option>
              <option value="score">Kecocokan</option>
            </select>
          </div>
          <button type="submit" className="secondary" disabled={busy}>
            Terapkan
          </button>
        </form>

        {jobs.length === 0 ? (
          <p className="muted" style={{ marginTop: 14 }}>
            Belum ada lowongan untuk filter ini. Tambahkan lewat impor manual di atas.
          </p>
        ) : (
          <ul className="card-list" style={{ marginTop: 14 }}>
            {orderedJobs.map((job) => (
              <li key={job.id}>
                <div style={{ flex: 1, minWidth: 260 }}>
                  <strong>{job.title || job.id}</strong>
                  <div className="muted">
                    {job.company || '-'}
                    {job.location ? ` · ${job.location}` : ''} · {job.source.name} ·{' '}
                    {new Date(job.listing.retrievedAt).toLocaleString('id-ID')}
                  </div>
                  <div className="row" style={{ marginTop: 6 }}>
                    <span
                      className={`badge ${
                        job.status === 'active'
                          ? 'ok'
                          : job.status === 'merged'
                            ? 'bad'
                            : 'warn'
                      }`}
                    >
                      {job.status}
                    </span>
                    {job.bookmarked ? <span className="badge ok">disimpan</span> : null}
                    <span className="badge">{job.provenance ?? 'unknown'}</span>
                    {job.listing.count > 1 ? (
                      <span className="badge warn">{job.listing.count} listing</span>
                    ) : null}
                  </div>
                  {job.description ? (
                    <p className="muted" style={{ fontSize: '0.9rem' }}>
                      {job.description.length > 320
                        ? `${job.description.slice(0, 320)}…`
                        : job.description}
                    </p>
                  ) : null}
                  {job.ignoredReason ? (
                    <p className="muted" style={{ fontSize: '0.85rem' }}>
                      Alasan arsip: {job.ignoredReason}
                    </p>
                  ) : null}
                  {job.latestEvaluation ? (
                    <details style={{ marginTop: 10 }}>
                      <summary>
                        {evaluationDecisionLabel(job.latestEvaluation.decision)}
                        {' · '}{job.latestEvaluation.score === null
                          ? 'skor belum cukup'
                          : `${job.latestEvaluation.score.toFixed(1)} / 100`}
                        {!evaluationIsCurrent(job) ? ' · versi lama' : ''}
                      </summary>
                      <p className="muted" style={{ fontSize: '0.85rem' }}>
                        Heuristik lokal · rubric {job.latestEvaluation.rubricVersion} · versi evaluasi {job.latestEvaluation.evaluationVersion}
                        {!evaluationIsCurrent(job)
                          ? ' · profil atau posting berubah sejak penilaian ini.'
                          : ' · snapshot profil dan posting masih cocok.'}
                      </p>
                      <ul>
                        {job.latestEvaluation.dimensions.map((dimension) => (
                          <li key={dimension.name}>
                            <strong>
                              {dimensionLabel(dimension.name)}:{' '}
                              {dimension.score === null ? 'belum cukup bukti' : `${dimension.score.toFixed(1)} / 100`}
                              {' · '}{Math.round(dimension.weight * 100)}%
                            </strong>
                            <div className="muted" style={{ fontSize: '0.85rem' }}>
                              {dimension.reason}
                            </div>
                            {dimension.evidence.length ? (
                              <div className="muted" style={{ fontSize: '0.8rem' }}>
                                Bukti: {dimension.evidence.map((item) => item.excerpt ?? item.reference).join(' · ')}
                              </div>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                      {job.latestEvaluation.hardFilters.length ? (
                        <div>
                          <strong>Filter</strong>
                          <ul>
                            {job.latestEvaluation.hardFilters.map((filter) => (
                              <li key={filter.name}>
                                <span className={`badge ${filter.state === 'pass' ? 'ok' : filter.state === 'fail' ? 'bad' : 'warn'}`}>
                                  {filter.state}
                                </span>{' '}
                                {filter.name}: {filter.reason}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {job.latestEvaluation.unknowns.length ? (
                        <p className="muted" style={{ fontSize: '0.85rem' }}>
                          Perlu dilengkapi: {job.latestEvaluation.unknowns.join(' · ')}
                        </p>
                      ) : null}
                    </details>
                  ) : null}
                  {aiReviews[job.id] ? (
                    <details style={{ marginTop: 10 }} open>
                      <summary>Review AI · {aiReviews[job.id]!.model} · perlu ditinjau pemilik</summary>
                      <p>{aiReviews[job.id]!.result.summary}</p>
                      {aiReviews[job.id]!.result.strengths.length ? (
                        <div>
                          <strong>Kecocokan yang disarankan</strong>
                          <ul>{aiReviews[job.id]!.result.strengths.map((item, index) => (
                            <li key={`${aiReviews[job.id]!.id}-s-${index}`}>
                              {item.claim} <span className="muted">· fakta: {item.factVersionIds.length} · posting: “{item.postingEvidence}”</span>
                            </li>
                          ))}</ul>
                        </div>
                      ) : null}
                      {aiReviews[job.id]!.result.gaps.length ? (
                        <div>
                          <strong>Gap yang perlu diperiksa</strong>
                          <ul>{aiReviews[job.id]!.result.gaps.map((item, index) => (
                            <li key={`${aiReviews[job.id]!.id}-g-${index}`}>
                              {item.description} <span className="muted">· posting: “{item.postingEvidence}”</span>
                            </li>
                          ))}</ul>
                        </div>
                      ) : null}
                      {aiReviews[job.id]!.result.questions.length ? (
                        <p className="muted">Pertanyaan: {aiReviews[job.id]!.result.questions.join(' · ')}</p>
                      ) : null}
                      <p className="muted" style={{ fontSize: '0.8rem' }}>
                        Versi profil {aiReviews[job.id]!.profileVersion} · {new Date(aiReviews[job.id]!.createdAt).toLocaleString('id-ID')}. Ini saran model, bukan bukti atau keputusan.
                      </p>
                    </details>
                  ) : null}
                </div>
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  {job.listing.canonicalUrl ? (
                    <a
                      href={job.listing.canonicalUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Buka sumber
                    </a>
                  ) : null}
                  <button
                    className="secondary"
                    onClick={() => patchJob(job, { bookmarked: !job.bookmarked })}
                    disabled={busy}
                  >
                    {job.bookmarked ? 'Batalkan simpan' : 'Simpan'}
                  </button>
                  <button
                    className="secondary"
                    onClick={() => void reviewJobWithAi(job)}
                    disabled={busy || !props.aiProviderReady || !job.listing.revisionId || !job.description}
                    title={!props.aiProviderReady ? 'Aktifkan dan tes provider terlebih dahulu.' : undefined}
                  >
                    Review dengan AI
                  </button>
                  <button
                    className="secondary"
                    onClick={() => evaluateJob(job)}
                    disabled={busy || !job.listing.revisionId}
                    title={!job.listing.revisionId ? 'Tambahkan deskripsi posting terlebih dahulu.' : undefined}
                  >
                    {evaluationIsCurrent(job) ? 'Hitung ulang' : 'Hitung kecocokan'}
                  </button>
                  {job.status === 'active' ? (
                    <button
                      className="danger"
                      onClick={() => archiveJob(job)}
                      disabled={busy}
                    >
                      Arsipkan
                    </button>
                  ) : job.status === 'archived' ? (
                    <button
                      className="secondary"
                      onClick={() => patchJob(job, { status: 'active' })}
                      disabled={busy}
                    >
                      Aktifkan
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
