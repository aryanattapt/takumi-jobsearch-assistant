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
      `Catat "${application.job.title}" sebagai sudah dikirim manual sekarang?\n\nIni hanya mencatat laporan Anda: tidak membuka browser, tidak memakai kuota, dan tidak membuat task.`,
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
          documentVersionsKnown: false,
          documentVersionIds: [],
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
          {applications.map((application) => (
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
          ))}
        </ul>
      )}
    </section>
  );
}
