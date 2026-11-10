'use client';

import { useCallback, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export interface TrackerApplication {
  id: string;
  jobId: string;
  submissionStatus: string;
  recruitmentStage: string;
  notes: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  job: {
    title: string;
    company: string;
    location: string | null;
    status: string;
    listingId: string | null;
  };
  latestAttemptState: string | null;
  latestSubmittedAt: string | null;
}

export interface TrackerJobOption {
  id: string;
  title: string;
  company: string;
}

export interface TrackerFactOption {
  id: string;
  type: string;
  value: unknown;
  verificationStatus: 'verified' | 'unverified' | 'retracted';
  version: number | null;
}

interface ApplicationDocumentVersion {
  id: string;
  applicationId: string;
  kind: 'cv' | 'cover_letter';
  versionNo: number;
  content: string;
  sourceFactVersionIds: string[];
  documentId: string;
  documentVersionId: string;
  documentStatus: 'active' | 'deleting' | 'deleted';
  pdfStatus: 'passed' | 'failed';
  pdfCheck: {
    pageCount: number;
    maxPages: number;
    textLayerPresent: boolean;
    layoutWithinPage: boolean;
    issues: string[];
  };
  reviewedAt: string | null;
  createdAt: string;
}

interface SavedApplicationAnswer {
  id: string;
  applicationId: string;
  question: string;
  answer: string;
  sourceFactIds: string[];
  sourceFactVersionIds: string[];
  verificationStatus: 'unverified' | 'verified' | 'needs_user_input' | 'retracted';
  version: number;
  createdAt: string;
  updatedAt: string;
  history: Array<{ versionNo: number; verificationStatus: string; createdAt: string }>;
}

export interface TrackerEvent {
  id: number;
  eventType: string;
  fromState: string | null;
  toState: string | null;
  actorType: string;
  reasonCode: string | null;
  occurredAt: string;
}

export interface ApplicationTrackerProps {
  csrfToken: string;
  applications: TrackerApplication[];
  jobs: TrackerJobOption[];
  facts: TrackerFactOption[];
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

const STAGES = [
  ['not_started', 'Belum mulai'],
  ['under_review', 'Sedang ditinjau'],
  ['interview', 'Interview'],
  ['offered', 'Ditawari'],
  ['rejected', 'Ditolak'],
  ['withdrawn', 'Ditarik'],
  ['unknown', 'Tidak diketahui'],
] as const;

const TERMINAL_SUBMISSIONS = ['submitted_confirmed', 'cancelled'];

function statusBadgeClass(status: string): string {
  if (status === 'submitted_confirmed') return 'ok';
  if (status === 'submit_unknown' || status === 'not_submitted') return 'warn';
  if (status === 'cancelled') return 'bad';
  return '';
}

export default function ApplicationTracker(props: ApplicationTrackerProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applications, setApplications] = useState(props.applications);
  const [selectedJob, setSelectedJob] = useState('');
  const [events, setEvents] = useState<Record<string, TrackerEvent[]>>({});
  const [openEvents, setOpenEvents] = useState<Record<string, boolean>>({});
  const [documentVersions, setDocumentVersions] = useState<Record<string, ApplicationDocumentVersion[]>>({});
  const [selectedFacts, setSelectedFacts] = useState<Record<string, string[]>>({});
  const [editedDrafts, setEditedDrafts] = useState<Record<string, string>>({});
  const [selectedSubmissionVersions, setSelectedSubmissionVersions] = useState<Record<string, string[]>>({});
  const [applicationAnswers, setApplicationAnswers] = useState<Record<string, SavedApplicationAnswer[]>>({});
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, string>>({});
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [answerSourceFactIds, setAnswerSourceFactIds] = useState<Record<string, string[]>>({});
  const [answerStatuses, setAnswerStatuses] = useState<Record<string, 'unverified' | 'verified' | 'needs_user_input' | 'retracted'>>({});
  const [answerConfirmed, setAnswerConfirmed] = useState<Record<string, boolean>>({});
  const [answerExpectedVersions, setAnswerExpectedVersions] = useState<Record<string, number | undefined>>({});
  const [answerSuggestionMessages, setAnswerSuggestionMessages] = useState<Record<string, string>>({});

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

  async function fetchApplications(): Promise<void> {
    const result = await callApi<{ applications: TrackerApplication[] }>(
      '/api/v1/applications',
      { method: 'GET' },
    );
    setApplications(result.applications);
  }

  async function createDraft(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selectedJob) {
      setError('Pilih lowongan terlebih dahulu.');
      return;
    }
    await run(async () => {
      await callApi('/api/v1/applications', {
        method: 'POST',
        csrf: props.csrfToken,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: selectedJob }),
      });
      setSelectedJob('');
      await fetchApplications();
      setMessage('Draft lamaran dibuat. Status pengiriman dan tahap rekrutmen terpisah.');
    });
  }

  async function recordManual(application: TrackerApplication): Promise<void> {
    if (!application.job.listingId) {
      setError('Lowongan ini tidak punya listing aktif untuk dicatat.');
      return;
    }
    const confirmed = window.confirm(
      `Catat "${application.job.title}" sebagai sudah dikirim manual sekarang?\n\nVersi PDF yang dipilih: ${selectedSubmissionVersions[application.id]?.length ?? 0}. Ini hanya mencatat laporan Anda: tidak membuka browser, tidak memakai kuota, dan tidak membuat task.`,
    );
    if (!confirmed) return;
    await run(async () => {
      await callApi(`/api/v1/applications/${application.id}/manual-submissions`, {
        method: 'POST',
        csrf: props.csrfToken,
        idempotencyKey: crypto.randomUUID(),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          listingId: application.job.listingId,
          submittedAt: new Date().toISOString(),
          documentVersionsKnown: (selectedSubmissionVersions[application.id]?.length ?? 0) > 0,
          documentVersionIds: selectedSubmissionVersions[application.id] ?? [],
          expectedVersion: application.version,
        }),
      });
      await fetchApplications();
      setMessage('Lamaran dicatat sebagai terkirim manual oleh pemilik.');
    });
  }

  async function changeStage(
    application: TrackerApplication,
    stage: string,
  ): Promise<void> {
    await run(async () => {
      await callApi(`/api/v1/applications/${application.id}/recruitment-stage`, {
        method: 'PATCH',
        csrf: props.csrfToken,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage, expectedVersion: application.version }),
      });
      await fetchApplications();
      setMessage('Tahap rekrutmen diperbarui tanpa mengubah status pengiriman.');
    });
  }

  async function editNotes(application: TrackerApplication): Promise<void> {
    const next = window.prompt('Catatan lamaran:', application.notes ?? '');
    if (next === null) return;
    await run(async () => {
      await callApi(`/api/v1/applications/${application.id}`, {
        method: 'PATCH',
        csrf: props.csrfToken,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notes: next.trim() === '' ? null : next,
          expectedVersion: application.version,
        }),
      });
      await fetchApplications();
      setMessage('Catatan lamaran disimpan.');
    });
  }

  async function loadEvents(application: TrackerApplication): Promise<void> {
    if (openEvents[application.id]) {
      setOpenEvents((current) => ({ ...current, [application.id]: false }));
      return;
    }
    await run(async () => {
      const result = await callApi<{ events: TrackerEvent[] }>(
        `/api/v1/applications/${application.id}/events`,
        { method: 'GET' },
      );
      setEvents((current) => ({ ...current, [application.id]: result.events }));
      setOpenEvents((current) => ({ ...current, [application.id]: true }));
    });
  }

  async function loadApplicationDocuments(applicationId: string): Promise<void> {
    const result = await callApi<{ versions: ApplicationDocumentVersion[] }>(
      `/api/v1/applications/${applicationId}/documents`,
      { method: 'GET' },
    );
    setDocumentVersions((current) => ({ ...current, [applicationId]: result.versions }));
    setEditedDrafts((current) => {
      const next = { ...current };
      for (const version of result.versions) next[version.id] = current[version.id] ?? version.content;
      return next;
    });
  }

  async function createDocumentDraft(
    application: TrackerApplication,
    kind: 'cv' | 'cover_letter',
  ): Promise<void> {
    const factIds = selectedFacts[application.id] ?? [];
    if (!factIds.length) {
      setError('Pilih minimal satu fakta terverifikasi untuk membuat dokumen.');
      return;
    }
    await run(async () => {
      await callApi<ApplicationDocumentVersion>(
        `/api/v1/applications/${application.id}/documents`,
        {
          method: 'POST',
          csrf: props.csrfToken,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind, factIds }),
        },
      );
      await loadApplicationDocuments(application.id);
      await fetchApplications();
      setMessage('Draf lokal dibuat. Periksa isi, versi fakta, dan PDF sebelum menandai ditinjau.');
    });
  }

  async function saveDocumentDraft(
    application: TrackerApplication,
    version: ApplicationDocumentVersion,
  ): Promise<void> {
    const content = editedDrafts[version.id] ?? version.content;
    await run(async () => {
      const saved = await callApi<ApplicationDocumentVersion>(
        `/api/v1/applications/${application.id}/documents/${version.id}`,
        {
          method: 'PATCH',
          csrf: props.csrfToken,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, expectedVersionNo: version.versionNo }),
        },
      );
      await loadApplicationDocuments(application.id);
      await fetchApplications();
      setMessage(`Versi ${saved.versionNo} dibuat. Versi baru belum ditandai ditinjau.`);
    });
  }

  async function reviewDocument(
    application: TrackerApplication,
    version: ApplicationDocumentVersion,
  ): Promise<void> {
    const confirmed = window.confirm(
      `Tandai ${version.kind === 'cv' ? 'CV' : 'cover letter'} v${version.versionNo} sebagai sudah Anda tinjau? PDF lulus pemeriksaan struktur, teks, dan batas halaman.`,
    );
    if (!confirmed) return;
    await run(async () => {
      await callApi<ApplicationDocumentVersion>(
        `/api/v1/applications/${application.id}/documents/${version.id}`,
        { method: 'POST', csrf: props.csrfToken },
      );
      await loadApplicationDocuments(application.id);
      await fetchApplications();
      setMessage('Versi dokumen ditandai sudah ditinjau pemilik.');
    });
  }

  async function loadApplicationAnswers(applicationId: string): Promise<void> {
    const result = await callApi<{ answers: SavedApplicationAnswer[] }>(
      `/api/v1/applications/${applicationId}/answers`,
      { method: 'GET' },
    );
    setApplicationAnswers((current) => ({ ...current, [applicationId]: result.answers }));
  }

  async function suggestApplicationAnswer(applicationId: string): Promise<void> {
    const question = questionDrafts[applicationId]?.trim() ?? '';
    if (!question) {
      setError('Masukkan pertanyaan formulir terlebih dahulu.');
      return;
    }
    await run(async () => {
      const result = await callApi<{
        status: 'suggested' | 'needs_review' | 'needs_user_input';
        reason: string;
        answer: { answer: string; sourceFactIds: string[]; verificationStatus: string } | null;
      }>('/api/v1/answer-bank/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      setAnswerSuggestionMessages((current) => ({
        ...current,
        [applicationId]: result.status === 'suggested'
          ? 'Jawaban cocok ditemukan. Teks dimasukkan ke draf lokal untuk Anda tinjau.'
          : result.status === 'needs_review'
            ? 'Jawaban serupa ditemukan tetapi perlu ditinjau; belum dianggap terverifikasi untuk lamaran ini.'
            : 'Tidak ada jawaban aman untuk pertanyaan ini. Isi sendiri; sistem tidak menebak.',
      }));
      setAnswerDrafts((current) => ({ ...current, [applicationId]: result.answer?.answer ?? '' }));
      setAnswerSourceFactIds((current) => ({ ...current, [applicationId]: result.answer?.sourceFactIds ?? [] }));
      setAnswerStatuses((current) => ({
        ...current,
        [applicationId]: result.status === 'needs_user_input' ? 'needs_user_input' : 'unverified',
      }));
      setAnswerConfirmed((current) => ({ ...current, [applicationId]: false }));
      setAnswerExpectedVersions((current) => ({ ...current, [applicationId]: undefined }));
    });
  }

  async function saveApplicationAnswer(applicationId: string): Promise<void> {
    const question = questionDrafts[applicationId]?.trim() ?? '';
    const answer = answerDrafts[applicationId] ?? '';
    const status = answerConfirmed[applicationId]
      ? 'verified'
      : answerStatuses[applicationId] ?? 'unverified';
    if (!question) {
      setError('Pertanyaan tidak boleh kosong.');
      return;
    }
    await run(async () => {
      await callApi(`/api/v1/applications/${applicationId}/answers`, {
        method: 'PUT',
        csrf: props.csrfToken,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          answer,
          sourceFactIds: answerSourceFactIds[applicationId] ?? [],
          verificationStatus: status,
          ...(answerExpectedVersions[applicationId] === undefined
            ? {} : { expectedVersion: answerExpectedVersions[applicationId] }),
        }),
      });
      await loadApplicationAnswers(applicationId);
      await fetchApplications();
      setMessage(status === 'needs_user_input'
        ? 'Pertanyaan disimpan sebagai butuh jawaban dari Anda.'
        : status === 'verified'
          ? 'Jawaban tersimpan sebagai versi yang sudah Anda konfirmasi.'
          : 'Jawaban tersimpan sebagai draf yang belum diverifikasi.');
      setAnswerExpectedVersions((current) => ({ ...current, [applicationId]: undefined }));
    });
  }

  function editApplicationAnswer(applicationId: string, answer: SavedApplicationAnswer): void {
    setQuestionDrafts((current) => ({ ...current, [applicationId]: answer.question }));
    setAnswerDrafts((current) => ({ ...current, [applicationId]: answer.answer }));
    setAnswerSourceFactIds((current) => ({ ...current, [applicationId]: answer.sourceFactIds }));
    setAnswerStatuses((current) => ({ ...current, [applicationId]: answer.verificationStatus }));
    setAnswerConfirmed((current) => ({ ...current, [applicationId]: answer.verificationStatus === 'verified' }));
    setAnswerExpectedVersions((current) => ({ ...current, [applicationId]: answer.version }));
  }

  return (
    <section className="panel" aria-labelledby="tracker-title">
      <h2 id="tracker-title">Tracker lamaran</h2>
      <p className="muted">
        Catat lamaran yang Anda kirim sendiri. Status pengiriman tidak berubah saat tahap
        rekrutmen diubah, dan pencatatan manual tidak memakai worker atau kuota.
      </p>

      <div aria-live="polite">
        {message ? <p className="notice">{message}</p> : null}
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <form className="row" onSubmit={createDraft} style={{ alignItems: 'flex-end' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <label htmlFor="tracker-job">Buat draft dari lowongan</label>
          <select
            id="tracker-job"
            value={selectedJob}
            onChange={(event) => setSelectedJob(event.target.value)}
          >
            <option value="">Pilih lowongan…</option>
            {props.jobs.map((job) => (
              <option key={job.id} value={job.id}>
                {job.title} · {job.company}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={busy || props.jobs.length === 0}>
          Buat draft
        </button>
      </form>

      {applications.length === 0 ? (
        <p className="muted" style={{ marginTop: 14 }}>
          Belum ada lamaran. Buat draft dari lowongan di atas.
        </p>
      ) : (
        <ul className="card-list" style={{ marginTop: 14 }}>
          {applications.map((application) => {
            const versions = documentVersions[application.id] ?? [];
            const latestVersionNo = (kind: 'cv' | 'cover_letter') =>
              Math.max(0, ...versions.filter((item) => item.kind === kind).map((item) => item.versionNo));
            return (
            <li key={application.id}>
              <div style={{ flex: 1, minWidth: 280 }}>
                <strong>{application.job.title || '(tanpa judul)'}</strong>
                <div className="muted">
                  {application.job.company}
                  {application.job.location ? ` · ${application.job.location}` : ''}
                </div>
                <div className="row" style={{ marginTop: 6 }}>
                  <span className={`badge ${statusBadgeClass(application.submissionStatus)}`}>
                    {application.submissionStatus}
                  </span>
                  <span className="badge">{application.recruitmentStage}</span>
                  {application.latestSubmittedAt ? (
                    <span className="muted" style={{ fontSize: '0.82rem' }}>
                      dilaporkan{' '}
                      {new Date(application.latestSubmittedAt).toLocaleString('id-ID')}
                    </span>
                  ) : null}
                </div>
                {application.notes ? (
                  <p className="muted" style={{ fontSize: '0.85rem' }}>
                    {application.notes}
                  </p>
                ) : null}
                <details
                  style={{ marginTop: 10 }}
                  onToggle={(event) => {
                    if (event.currentTarget.open && documentVersions[application.id] === undefined) {
                      void loadApplicationDocuments(application.id).catch((cause) => {
                        setError(cause instanceof Error ? cause.message : 'Dokumen gagal dimuat');
                      });
                    }
                  }}
                >
                  <summary>CV, cover letter & versi PDF ({versions.length})</summary>
                  <p className="muted" style={{ fontSize: '0.82rem' }}>
                    Draf dibuat dari template lokal tanpa mengirim profil ke AI. Pilih fakta terverifikasi
                    satu per satu. Hanya versi yang Anda tandai sudah ditinjau yang dapat dipilih untuk
                    catatan pengiriman manual.
                  </p>
                  <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
                    <legend>Fakta untuk draf ini</legend>
                    {props.facts.filter((fact) =>
                      fact.verificationStatus === 'verified' &&
                      ['contact', 'location', 'education', 'work_experience', 'skill', 'language'].includes(fact.type),
                    ).length === 0 ? (
                      <p className="muted">Belum ada fakta terverifikasi yang dapat dipakai untuk dokumen.</p>
                    ) : (
                      <div className="grid">
                        {props.facts
                          .filter((fact) => fact.verificationStatus === 'verified' &&
                            ['contact', 'location', 'education', 'work_experience', 'skill', 'language'].includes(fact.type))
                          .map((fact) => (
                            <label key={fact.id} htmlFor={`doc-fact-${application.id}-${fact.id}`} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                              <input
                                id={`doc-fact-${application.id}-${fact.id}`}
                                type="checkbox"
                                checked={(selectedFacts[application.id] ?? []).includes(fact.id)}
                                onChange={(event) => setSelectedFacts((current) => {
                                  const before = current[application.id] ?? [];
                                  return {
                                    ...current,
                                    [application.id]: event.target.checked
                                      ? [...new Set([...before, fact.id])]
                                      : before.filter((id) => id !== fact.id),
                                  };
                                })}
                              />
                              <span>{fact.type} v{fact.version ?? '?'}: {JSON.stringify(fact.value)}</span>
                            </label>
                          ))}
                      </div>
                    )}
                  </fieldset>
                  <div className="row" style={{ marginTop: 8 }}>
                    <button type="button" className="secondary" disabled={busy} onClick={() => void createDocumentDraft(application, 'cv')}>
                      Buat draf CV
                    </button>
                    <button type="button" className="secondary" disabled={busy} onClick={() => void createDocumentDraft(application, 'cover_letter')}>
                      Buat cover letter
                    </button>
                  </div>
                  {versions.length === 0 ? <p className="muted">Belum ada versi dokumen.</p> : null}
                  <ul className="card-list" style={{ marginTop: 10 }}>
                    {versions.map((version) => {
                      const isLatest = version.versionNo === latestVersionNo(version.kind);
                      const selected = (selectedSubmissionVersions[application.id] ?? []).includes(version.documentVersionId);
                      return (
                        <li key={version.id}>
                          <div style={{ flex: 1, minWidth: 240 }}>
                            <strong>{version.kind === 'cv' ? 'CV' : 'Cover letter'} v{version.versionNo}</strong>
                            <div className="muted" style={{ fontSize: '0.82rem' }}>
                              PDF {version.pdfStatus} · {version.pdfCheck.pageCount}/{version.pdfCheck.maxPages} halaman
                              · text layer {version.pdfCheck.textLayerPresent ? 'lulus' : 'gagal'}
                              · layout {version.pdfCheck.layoutWithinPage ? 'lulus' : 'gagal'}
                              · file {version.documentStatus}
                              · {version.sourceFactVersionIds.length} versi fakta
                              {version.reviewedAt ? ' · ditinjau pemilik' : ' · belum ditinjau'}
                            </div>
                            <a href={`/api/v1/documents/${version.documentId}/download`}>Unduh PDF</a>
                            {isLatest ? (
                              <div style={{ marginTop: 8 }}>
                                <label htmlFor={`doc-content-${version.id}`}>Isi draf (edit lalu simpan sebagai versi baru)</label>
                                <textarea
                                  id={`doc-content-${version.id}`}
                                  rows={7}
                                  value={editedDrafts[version.id] ?? version.content}
                                  onChange={(event) => setEditedDrafts((current) => ({ ...current, [version.id]: event.target.value }))}
                                />
                                <div className="row" style={{ marginTop: 6 }}>
                                  {(editedDrafts[version.id] ?? version.content) !== version.content ? (
                                    <button type="button" disabled={busy} onClick={() => void saveDocumentDraft(application, version)}>Simpan versi baru</button>
                                  ) : null}
                                  {!version.reviewedAt ? (
                                    <button type="button" className="secondary" disabled={busy || version.pdfStatus !== 'passed'} onClick={() => void reviewDocument(application, version)}>
                                      Tandai sudah ditinjau
                                    </button>
                                  ) : null}
                                </div>
                              </div>
                            ) : null}
                          </div>
                          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <input
                              type="checkbox"
                              checked={selected}
                              disabled={busy || !version.reviewedAt || version.pdfStatus !== 'passed' || version.documentStatus !== 'active'}
                              onChange={(event) => setSelectedSubmissionVersions((current) => {
                                const before = current[application.id] ?? [];
                                return {
                                  ...current,
                                  [application.id]: event.target.checked
                                    ? [...new Set([...before, version.documentVersionId])]
                                    : before.filter((id) => id !== version.documentVersionId),
                                };
                              })}
                            />
                            Cantumkan saat mencatat terkirim
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </details>
                <details
                  style={{ marginTop: 10 }}
                  onToggle={(event) => {
                    if (event.currentTarget.open && applicationAnswers[application.id] === undefined) {
                      void loadApplicationAnswers(application.id).catch((cause) => {
                        setError(cause instanceof Error ? cause.message : 'Jawaban lamaran gagal dimuat');
                      });
                    }
                  }}
                >
                  <summary>Screening Q&A ({(applicationAnswers[application.id] ?? []).length})</summary>
                  <p className="muted" style={{ fontSize: '0.82rem' }}>
                    Saran diambil dari answer bank dan disimpan sebagai draf per lamaran. Tidak ada
                    pengisian atau pengiriman form portal di Phase 3. Pertanyaan sensitif/tidak dikenal
                    berhenti di status butuh input sampai Anda menulis jawabannya sendiri.
                  </p>
                  <label htmlFor={`screen-question-${application.id}`}>Pertanyaan formulir</label>
                  <textarea
                    id={`screen-question-${application.id}`}
                    rows={2}
                    value={questionDrafts[application.id] ?? ''}
                    onChange={(event) => {
                      setQuestionDrafts((current) => ({ ...current, [application.id]: event.target.value }));
                      setAnswerConfirmed((current) => ({ ...current, [application.id]: false }));
                      setAnswerSourceFactIds((current) => ({ ...current, [application.id]: [] }));
                    }}
                  />
                  <div className="row" style={{ marginTop: 6 }}>
                    <button type="button" className="secondary" disabled={busy} onClick={() => void suggestApplicationAnswer(application.id)}>
                      Cari saran di answer bank
                    </button>
                    {answerSuggestionMessages[application.id] ? (
                      <span className="muted">{answerSuggestionMessages[application.id]}</span>
                    ) : null}
                  </div>
                  <label htmlFor={`screen-answer-${application.id}`}>Jawaban draf</label>
                  <textarea
                    id={`screen-answer-${application.id}`}
                    rows={4}
                    maxLength={10_000}
                    value={answerDrafts[application.id] ?? ''}
                    onChange={(event) => {
                      const value = event.target.value;
                      setAnswerDrafts((current) => ({ ...current, [application.id]: value }));
                      setAnswerConfirmed((current) => ({ ...current, [application.id]: false }));
                      if (value.trim()) {
                        setAnswerStatuses((current) => ({
                          ...current,
                          [application.id]: current[application.id] === 'needs_user_input' ? 'unverified' : current[application.id] ?? 'unverified',
                        }));
                      }
                    }}
                    placeholder={answerStatuses[application.id] === 'needs_user_input'
                      ? 'Isi sendiri; sistem tidak membuat jawaban untuk pertanyaan ini.'
                      : 'Tinjau atau tulis jawaban.'}
                  />
                  <p className="muted" style={{ fontSize: '0.8rem' }}>
                    Status saat disimpan: {answerConfirmed[application.id]
                      ? 'sudah dikonfirmasi pemilik'
                      : answerStatuses[application.id] ?? 'draf belum diverifikasi'}
                    {answerSourceFactIds[application.id]?.length
                      ? ` · ${answerSourceFactIds[application.id]!.length} fakta terverifikasi tertaut`
                      : ''}
                  </p>
                  <div className="row" style={{ marginTop: 6 }}>
                    <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={answerConfirmed[application.id] ?? false}
                        onChange={(event) => {
                          setAnswerConfirmed((current) => ({ ...current, [application.id]: event.target.checked }));
                          setAnswerStatuses((current) => ({ ...current, [application.id]: event.target.checked ? 'verified' : 'unverified' }));
                        }}
                      />
                      Saya sudah memeriksa dan mengonfirmasi jawaban ini
                    </label>
                    <button type="button" disabled={busy} onClick={() => void saveApplicationAnswer(application.id)}>
                      Simpan versi jawaban
                    </button>
                  </div>
                  {(applicationAnswers[application.id] ?? []).length ? (
                    <ul className="card-list" style={{ marginTop: 10 }}>
                      {applicationAnswers[application.id]!.map((answer) => (
                        <li key={answer.id}>
                          <div style={{ flex: 1, minWidth: 220 }}>
                            <strong>{answer.question}</strong>
                            <p>{answer.answer || 'Belum ada jawaban; perlu input pemilik.'}</p>
                            <span className="badge">{answer.verificationStatus}</span>{' '}
                            <span className="muted">v{answer.version} · {answer.history.length} snapshot tersimpan</span>
                          <details style={{ marginTop: 6 }}>
                            <summary>Lihat riwayat jawaban</summary>
                            <ol>
                              {answer.history.map((version) => (
                                <li key={version.versionNo}>
                                  v{version.versionNo} · {version.verificationStatus} · {new Date(version.createdAt).toLocaleString('id-ID')}
                                </li>
                              ))}
                            </ol>
                          </details>
                          </div>
                          <button type="button" className="secondary" disabled={busy} onClick={() => editApplicationAnswer(application.id, answer)}>
                            Edit jawaban
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </details>
                {openEvents[application.id] ? (
                  <ul className="card-list" style={{ marginTop: 8 }}>
                    {(events[application.id] ?? []).map((event) => (
                      <li key={event.id}>
                        <span>
                          {event.eventType}
                          {event.fromState || event.toState
                            ? ` · ${event.fromState ?? '-'} → ${event.toState ?? '-'}`
                            : ''}
                        </span>
                        <span className="muted">
                          {event.actorType} ·{' '}
                          {new Date(event.occurredAt).toLocaleString('id-ID')}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <div>
                  <label htmlFor={`stage-${application.id}`}>Tahap</label>
                  <select
                    id={`stage-${application.id}`}
                    value={application.recruitmentStage}
                    onChange={(event) => changeStage(application, event.target.value)}
                    disabled={busy}
                  >
                    {STAGES.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                {!TERMINAL_SUBMISSIONS.includes(application.submissionStatus) ? (
                  <button onClick={() => recordManual(application)} disabled={busy}>
                    Catat terkirim
                  </button>
                ) : null}
                <button
                  className="secondary"
                  onClick={() => editNotes(application)}
                  disabled={busy}
                >
                  Catatan
                </button>
                <button
                  className="secondary"
                  onClick={() => loadEvents(application)}
                  disabled={busy}
                >
                  {openEvents[application.id] ? 'Tutup riwayat' : 'Riwayat'}
                </button>
              </div>
            </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
