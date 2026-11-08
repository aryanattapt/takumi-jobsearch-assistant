'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState, type FormEvent } from 'react';

export interface DashboardDocument {
  id: string;
  kind: string;
  originalName: string;
  mediaType: string;
  sizeBytes: number;
  status: string;
  version: number;
  createdAt: string;
}

export interface DashboardPrivacyRequest {
  id: string;
  kind: 'export' | 'deletion';
  status: string;
  artifactAvailable: boolean;
  createdAt: string;
}

export interface DashboardTask {
  id: string;
  kind: string;
  state: string;
  lastError: string | null;
}

export interface DashboardProps {
  owner: { email: string; timezone: string; privacyGeneration: number };
  csrfToken: string;
  documents: DashboardDocument[];
  privacyRequests: DashboardPrivacyRequest[];
  tasks: DashboardTask[];
  browserEnabled: boolean;
  activeHolds: number;
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Dashboard(props: DashboardProps) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exportRequestId, setExportRequestId] = useState<string | null>(null);
  const [exportState, setExportState] = useState<string | null>(null);

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

  async function uploadDocument(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await run(async () => {
      await callApi('/api/v1/documents', {
        method: 'POST',
        body: data,
        csrf: props.csrfToken,
      });
      form.reset();
      setMessage('Dokumen diunggah dan disimpan di penyimpanan privat.');
    });
  }

  async function logout(): Promise<void> {
    await run(async () => {
      await callApi('/api/v1/auth/logout', {
        method: 'POST',
        csrf: props.csrfToken,
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      });
      window.location.assign('/login');
    });
  }

  async function createExport(): Promise<void> {
    await run(async () => {
      const result = await callApi<{ privacyRequestId: string; taskId: string }>(
        '/api/v1/privacy/exports',
        {
          method: 'POST',
          csrf: props.csrfToken,
          idempotencyKey: crypto.randomUUID(),
          body: JSON.stringify({}),
          headers: { 'Content-Type': 'application/json' },
        },
      );
      setExportRequestId(result.privacyRequestId);
      setExportState('queued');
      setMessage('Ekspor sedang dibuat. Artefak tersedia sementara setelah selesai.');
      void pollExport(result.privacyRequestId);
    });
  }

  async function pollExport(id: string): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        const request = await callApi<DashboardPrivacyRequest>(
          `/api/v1/privacy/requests/${id}`,
          { method: 'GET', headers: { 'Content-Type': 'application/json' } },
        );
        setExportState(request.status);
        if (request.status === 'completed' || request.status === 'failed') {
          router.refresh();
          return;
        }
      } catch {
        return;
      }
    }
  }

  async function deleteDocument(document: DashboardDocument): Promise<void> {
    const confirmed = window.confirm(
      `Hapus "${document.originalName}"? Akses unduhan ditutup segera dan penghapusan fisik berjalan di latar belakang.`,
    );
    if (!confirmed) return;
    await run(async () => {
      await callApi(`/api/v1/documents/${document.id}`, {
        method: 'DELETE',
        csrf: props.csrfToken,
        idempotencyKey: crypto.randomUUID(),
        headers: {
          'Content-Type': 'application/json',
          'If-Match': String(document.version),
        },
        body: JSON.stringify({}),
      });
      setMessage('Permintaan penghapusan diterima; status purge dapat dipantau di aktivitas.');
    });
  }

  async function resetWorkspace(): Promise<void> {
    const phrase = window.prompt(
      'Reset menghapus profil, lowongan, lamaran, dokumen, dan ekspor, lalu menonaktifkan submit browser sampai histori portal direkonsiliasi.\n\nKetik DELETE_WORKSPACE untuk melanjutkan:',
    );
    if (phrase !== 'DELETE_WORKSPACE') return;
    await run(async () => {
      await callApi('/api/v1/privacy/deletions', {
        method: 'POST',
        csrf: props.csrfToken,
        idempotencyKey: crypto.randomUUID(),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'DELETE_WORKSPACE' }),
      });
      setMessage('Reset workspace diterima dan sedang dijalankan.');
    });
  }

  return (
    <main>
      <header className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>Workspace</h1>
          <p className="muted" style={{ margin: 0 }}>
            {props.owner.email} · {props.owner.timezone} · generasi privasi{' '}
            {props.owner.privacyGeneration}
          </p>
        </div>
        <button className="secondary" onClick={logout} disabled={busy}>
          Keluar
        </button>
      </header>

      <div aria-live="polite">
        {message ? <p className="notice">{message}</p> : null}
        {error ? <p className="error" role="alert">{error}</p> : null}
      </div>

      <section className="grid" aria-label="Ringkasan">
        <div className="stat">
          <span className="muted">Dokumen aktif</span>
          <strong>{props.documents.filter((doc) => doc.status === 'active').length}</strong>
        </div>
        <div className="stat">
          <span className="muted">Task berjalan/antre</span>
          <strong>
            {props.tasks.filter((task) => ['queued', 'running'].includes(task.state)).length}
          </strong>
        </div>
        <div className="stat">
          <span className="muted">Submit browser</span>
          <strong>{props.browserEnabled ? 'Aktif' : 'Nonaktif'}</strong>
          <span className="badge warn">Penahanan recovery: {props.activeHolds}</span>
        </div>
      </section>

      <section className="panel" aria-labelledby="docs-title">
        <h2 id="docs-title">Dokumen privat</h2>
        <p className="muted">
          Hanya PDF, PNG/JPEG, DOCX, dan teks yang diterima. File divalidasi dari isinya,
          diberi nama acak, dan tidak pernah disajikan sebagai URL publik.
        </p>
        <form className="row" onSubmit={uploadDocument} style={{ marginBottom: 16 }}>
          <div>
            <label htmlFor="document-file">File</label>
            <input id="document-file" name="file" type="file" required />
          </div>
          <div>
            <label htmlFor="document-kind">Jenis</label>
            <select id="document-kind" name="kind" defaultValue="cv">
              <option value="cv">CV</option>
              <option value="cover_letter">Cover letter</option>
              <option value="evidence">Bukti</option>
              <option value="other">Lainnya</option>
            </select>
          </div>
          <button type="submit" disabled={busy}>Unggah</button>
        </form>

        {props.documents.length === 0 ? (
          <p className="muted">Belum ada dokumen.</p>
        ) : (
          <ul className="card-list">
            {props.documents.map((document) => (
              <li key={document.id}>
                <div>
                  <strong>{document.originalName}</strong>
                  <div className="muted" style={{ fontSize: '0.85rem' }}>
                    {document.kind} · {formatBytes(document.sizeBytes)} ·{' '}
                    <span className={`badge ${document.status === 'active' ? 'ok' : 'warn'}`}>
                      {document.status}
                    </span>
                  </div>
                </div>
                <div className="row">
                  {document.status === 'active' ? (
                    <a href={`/api/v1/documents/${document.id}/download`}>Unduh</a>
                  ) : null}
                  <button
                    className="danger"
                    onClick={() => deleteDocument(document)}
                    disabled={busy || document.status !== 'active'}
                  >
                    Hapus
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="privacy-title">
        <h2 id="privacy-title">Ekspor &amp; privasi</h2>
        <div className="row">
          <button onClick={createExport} disabled={busy}>
            Buat ekspor workspace
          </button>
          {exportRequestId ? (
            <span className="badge warn">Permintaan {exportState ?? 'queued'}</span>
          ) : null}
          {exportRequestId && exportState === 'completed' ? (
            <a href={`/api/v1/privacy/requests/${exportRequestId}/download`}>
              Unduh ekspor (ZIP)
            </a>
          ) : null}
          <button className="danger" onClick={resetWorkspace} disabled={busy}>
            Reset workspace
          </button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Ekspor berisi profil, fakta, lowongan, lamaran, jawaban tersimpan, dokumen yang
          tersedia, dan manifest. Secret, cookie, profil browser, serta backup tidak
          disertakan.
        </p>

        {props.privacyRequests.length > 0 ? (
          <ul className="card-list" style={{ marginTop: 14 }}>
            {props.privacyRequests.map((request) => (
              <li key={request.id}>
                <span>
                  {request.kind} ·{' '}
                  <span
                    className={`badge ${
                      request.status === 'completed'
                        ? 'ok'
                        : request.status === 'failed'
                          ? 'bad'
                          : 'warn'
                    }`}
                  >
                    {request.status}
                  </span>
                </span>
                <span className="muted">
                  {new Date(request.createdAt).toLocaleString('id-ID')}
                  {request.artifactAvailable
                    ? ` · ${request.kind === 'export' ? 'siap diunduh' : ''}`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="panel" aria-labelledby="tasks-title">
        <h2 id="tasks-title">Aktivitas pekerjaan</h2>
        {props.tasks.length === 0 ? (
          <p className="muted">Belum ada task.</p>
        ) : (
          <ul className="card-list">
            {props.tasks.map((task) => (
              <li key={task.id}>
                <span>
                  {task.kind}{' '}
                  <span
                    className={`badge ${
                      task.state === 'done'
                        ? 'ok'
                        : task.state === 'failed'
                          ? 'bad'
                          : 'warn'
                    }`}
                  >
                    {task.state}
                  </span>
                </span>
                <span className="muted">{task.lastError ?? ''}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
