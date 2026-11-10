'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

export interface DashboardRecoveryHold {
  id: string;
  scope: 'global' | 'source' | 'target';
  scopeKey: string;
  checkpointAt: string;
  windowEndAt: string | null;
  version: number;
}

interface RecoveryAttempt {
  id: string;
  applicationId: string;
  applicationStatus: string;
  jobTitle: string;
  companyName: string;
  targetKey: string | null;
  mode: string;
  state: string;
  version: number;
  dispatchIntentAt: string | null;
  sourceCode: string | null;
  portalAccountLabel: string | null;
}

type RecoveryOutcome = 'confirmed_sent' | 'confirmed_not_sent' | 'unknown';

interface ApiEnvelope<T> {
  data?: T;
  error?: { code?: string; message?: string };
}

async function apiRequest<T>(
  url: string,
  init: RequestInit,
  csrfToken?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (csrfToken) headers.set('x-csrf-token', csrfToken);
  const response = await fetch(url, { ...init, headers, cache: 'no-store' });
  const payload = (await response.json().catch(() => ({}))) as ApiEnvelope<T>;
  if (!response.ok || payload.error) {
    throw new Error(payload.error?.message ?? 'Request failed (' + response.status + ')');
  }
  return payload.data as T;
}

function postJson<T>(
  url: string,
  body: Record<string, unknown>,
  csrfToken: string,
): Promise<T> {
  return apiRequest<T>(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  }, csrfToken);
}

function toLocalDateTime(value: string): string {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

function stateLabel(state: string): string {
  switch (state) {
    case 'reserved':
      return 'Reservasi aktif, belum ada hasil';
    case 'running':
      return 'Proses aktif, belum ada hasil';
    case 'submitting':
      return 'Submit menunggu rekonsiliasi';
    case 'submit_unknown':
      return 'Hasil belum diketahui';
    case 'submitted_confirmed':
      return 'Terkirim, dicatat manual';
    case 'not_submitted':
      return 'Tidak terkirim';
    case 'cancelled':
      return 'Dibatalkan';
    default:
      return state;
  }
}

function AttemptReconciliationForm({
  holdId,
  attempt,
  csrfToken,
  onSaved,
}: {
  holdId: string;
  attempt: RecoveryAttempt;
  csrfToken: string;
  onSaved: () => Promise<void>;
}) {
  const [outcome, setOutcome] = useState<RecoveryOutcome>('unknown');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const note = String(formData.get('note') ?? '').trim();
      const evidenceRef = String(formData.get('evidenceRef') ?? '').trim();
      let body: Record<string, unknown> = {
        expectedAttemptVersion: attempt.version,
        outcome,
        note,
        ...(evidenceRef ? { evidenceRef } : {}),
      };

      if (outcome === 'confirmed_sent') {
        const localTime = String(formData.get('submittedAt') ?? '');
        const submittedAt = new Date(localTime);
        if (!localTime || Number.isNaN(submittedAt.getTime())) {
          throw new Error('Masukkan waktu pengiriman yang valid.');
        }
        body = {
          ...body,
          submittedAt: submittedAt.toISOString(),
          targetAndAccountMatched: formData.has('targetAndAccountMatched'),
        };
      } else if (outcome === 'confirmed_not_sent') {
        body = {
          ...body,
          oldSessionStopped: formData.has('oldSessionStopped'),
          authoritativeRejectionConfirmed: formData.has('authoritativeRejectionConfirmed'),
          noPendingRequestConfirmed: formData.has('noPendingRequestConfirmed'),
        };
      }

      await postJson(
        '/api/v1/submission-recovery/holds/' + holdId + '/attempts/' + attempt.id,
        body,
        csrfToken,
      );
      setMessage(outcome === 'unknown'
        ? 'Hasil tetap unknown; hold dan pengunci target tetap aktif.'
        : 'Hasil dicatat sebagai laporan manual pemilik. Kuota tetap terpakai.');
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Rekonsiliasi gagal');
    } finally {
      setBusy(false);
    }
  }

  if (!attempt.dispatchIntentAt || !['submitting', 'submit_unknown'].includes(attempt.state)) {
    return (
      <p className="muted">
        Attempt ini belum dapat direkonsiliasi di sini. Batalkan reservasi yang belum memiliki
        intent dari Application Tracker sebelum melepas hold.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="stack">
      <div>
        <label htmlFor={'outcome-' + attempt.id}>Hasil pemeriksaan</label>
        <select
          id={'outcome-' + attempt.id}
          value={outcome}
          onChange={(event) => setOutcome(event.target.value as RecoveryOutcome)}
          disabled={busy}
        >
          <option value="unknown">Belum diketahui</option>
          <option value="confirmed_sent">Terkirim</option>
          <option value="confirmed_not_sent">Tidak terkirim</option>
        </select>
      </div>

      {outcome !== 'unknown' ? (
        <div>
          <label htmlFor={'evidence-' + attempt.id}>Referensi bukti</label>
          <input
            id={'evidence-' + attempt.id}
            name="evidenceRef"
            type="text"
            minLength={3}
            maxLength={300}
            required
            disabled={busy}
            placeholder="ID receipt atau referensi catatan"
          />
        </div>
      ) : (
        <div>
          <label htmlFor={'evidence-' + attempt.id}>Referensi pemeriksaan (opsional)</label>
          <input
            id={'evidence-' + attempt.id}
            name="evidenceRef"
            type="text"
            maxLength={300}
            disabled={busy}
            placeholder="Contoh: riwayat portal diperiksa pukul 10.30"
          />
        </div>
      )}

      {outcome === 'confirmed_sent' ? (
        <>
          <div>
            <label htmlFor={'submitted-at-' + attempt.id}>Waktu pengiriman yang tertera</label>
            <input id={'submitted-at-' + attempt.id} name="submittedAt" type="datetime-local" required disabled={busy} />
          </div>
          <label>
            <input type="checkbox" name="targetAndAccountMatched" required disabled={busy} />
            Receipt cocok dengan target lowongan dan akun portal ini.
          </label>
        </>
      ) : null}

      {outcome === 'confirmed_not_sent' ? (
        <div className="stack">
          <label>
            <input type="checkbox" name="oldSessionStopped" required disabled={busy} />
            Sesi/browser lama sudah dihentikan atau aksesnya dicabut.
          </label>
          <label>
            <input type="checkbox" name="authoritativeRejectionConfirmed" required disabled={busy} />
            Bukti resmi menunjukkan request ditolak sebelum lamaran dibuat.
          </label>
          <label>
            <input type="checkbox" name="noPendingRequestConfirmed" required disabled={busy} />
            Portal mengonfirmasi request tidak diterima dan tidak tertunda.
          </label>
        </div>
      ) : null}

      <div>
        <label htmlFor={'note-' + attempt.id}>Catatan singkat</label>
        <textarea
          id={'note-' + attempt.id}
          name="note"
          minLength={5}
          maxLength={500}
          required
          disabled={busy}
          placeholder="Jelaskan apa yang diperiksa. Jangan masukkan CV, password, OTP, atau cookie."
        />
      </div>
      <p className="muted">
        Bukti di sini dicatat sebagai pemeriksaan manual pemilik; aplikasi tidak membuka atau
        memverifikasi halaman portal.
      </p>
      {message ? <p className="notice" role="status">{message}</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      <button type="submit" disabled={busy}>
        {busy ? 'Menyimpan…' : outcome === 'unknown' ? 'Catat hasil belum diketahui' : 'Catat hasil rekonsiliasi'}
      </button>
    </form>
  );
}

function RecoveryHoldCard({
  hold,
  csrfToken,
}: {
  hold: DashboardRecoveryHold;
  csrfToken: string;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [attempts, setAttempts] = useState<RecoveryAttempt[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function loadAttempts(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const rows = await apiRequest<RecoveryAttempt[]>(
        '/api/v1/submission-recovery/holds/' + hold.id + '/attempts',
        { method: 'GET' },
      );
      setAttempts(rows);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Gagal memuat attempt');
    } finally {
      setLoading(false);
    }
  }

  async function toggleDetails(): Promise<void> {
    setExpanded((value) => !value);
    if (!expanded && attempts === null) await loadAttempts();
  }

  async function refreshAfterReconciliation(): Promise<void> {
    await loadAttempts();
    router.refresh();
  }

  async function release(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!attempts) {
      setError('Muat dan periksa daftar attempt sebelum melepas hold.');
      return;
    }
    const formData = new FormData(event.currentTarget);
    const coverageStartedAt = new Date(String(formData.get('coverageStartedAt') ?? ''));
    const coverageEndedAt = new Date(String(formData.get('coverageEndedAt') ?? ''));
    if (Number.isNaN(coverageStartedAt.getTime()) || Number.isNaN(coverageEndedAt.getTime())) {
      setError('Masukkan rentang waktu pemeriksaan yang valid.');
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await postJson(
        '/api/v1/submission-recovery/holds/' + hold.id + '/release',
        {
          expectedVersion: hold.version,
          coverageStartedAt: coverageStartedAt.toISOString(),
          coverageEndedAt: coverageEndedAt.toISOString(),
          evidenceRef: String(formData.get('evidenceRef') ?? '').trim(),
          resolutionNote: String(formData.get('resolutionNote') ?? '').trim(),
          oldProcessStopped: formData.has('oldProcessStopped'),
          externalActivityReviewed: formData.has('externalActivityReviewed'),
          quotaReconciled: formData.has('quotaReconciled'),
        },
        csrfToken,
      );
      setMessage('Hold dilepas untuk cakupan yang sudah diperiksa. Browser submission tetap nonaktif.');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Hold belum dapat dilepas');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li>
      <div>
        <strong>{hold.scope}{hold.scopeKey ? ' · ' + hold.scopeKey : ''}</strong>
        <div className="muted" style={{ fontSize: '0.85rem' }}>
          Checkpoint {new Date(hold.checkpointAt).toLocaleString('id-ID')}
          {hold.windowEndAt
            ? ' · Batas jendela ' + new Date(hold.windowEndAt).toLocaleString('id-ID')
            : ' · Batas jendela belum diketahui'}
          {' · '}versi {hold.version}
        </div>
      </div>
      <span className="badge warn">aktif</span>
      <button type="button" aria-expanded={expanded} onClick={() => void toggleDetails()} disabled={loading}>
        {loading ? 'Memuat attempt…' : expanded ? 'Tutup rekonsiliasi' : 'Periksa dan rekonsiliasi'}
      </button>

      {expanded ? (
        <div className="stack" style={{ width: '100%', marginTop: 12 }}>
          <p className="muted">
            Cocokkan semua aktivitas pada portal dengan data yang pulih. Referensi manual adalah
            laporan pemilik dan tidak diverifikasi otomatis.
          </p>
          {attempts ? (
            attempts.length > 0 ? (
              <ul className="card-list">
                {attempts.map((attempt) => (
                  <li key={attempt.id}>
                    <div>
                      <strong>{attempt.jobTitle} · {attempt.companyName}</strong>
                      <div className="muted" style={{ fontSize: '0.85rem' }}>
                        {attempt.sourceCode ?? 'Sumber tidak diketahui'}
                        {attempt.portalAccountLabel ? ' · akun ' + attempt.portalAccountLabel : ''}
                        {attempt.dispatchIntentAt
                          ? ' · intent ' + new Date(attempt.dispatchIntentAt).toLocaleString('id-ID')
                          : ' · belum ada intent'}
                      </div>
                      <div className="muted" style={{ fontSize: '0.85rem' }}>
                        Status: {stateLabel(attempt.state)} · aplikasi {attempt.applicationId}
                      </div>
                    </div>
                    {['submitting', 'submit_unknown', 'reserved', 'running'].includes(attempt.state) ? (
                      <AttemptReconciliationForm
                        holdId={hold.id}
                        attempt={attempt}
                        csrfToken={csrfToken}
                        onSaved={refreshAfterReconciliation}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="notice">Tidak ada attempt terkait yang tersimpan pada database pulih.</p>
            )
          ) : null}

          <form onSubmit={release} className="stack">
            <h3>Checklist pelepasan hold</h3>
            <p className="muted">
              Hold hanya dilepas setelah semua attempt berdampak selesai direkonsiliasi. Aktivitas
              yang tidak ada di database pulih harus dicocokkan dengan portal dan dicatat melalui
              Application Tracker. Hari kuota yang belum dapat dihitung harus tetap ditahan.
            </p>
            <div>
              <label htmlFor={'coverage-start-' + hold.id}>Cakupan diperiksa mulai</label>
              <input
                id={'coverage-start-' + hold.id}
                name="coverageStartedAt"
                type="datetime-local"
                defaultValue={toLocalDateTime(hold.checkpointAt)}
                required
                disabled={busy}
              />
            </div>
            <div>
              <label htmlFor={'coverage-end-' + hold.id}>Cakupan diperiksa sampai</label>
              <input
                id={'coverage-end-' + hold.id}
                name="coverageEndedAt"
                type="datetime-local"
                defaultValue={toLocalDateTime(hold.windowEndAt ?? new Date().toISOString())}
                required
                disabled={busy}
              />
            </div>
            <div>
              <label htmlFor={'history-ref-' + hold.id}>Referensi riwayat/bukti pemeriksaan</label>
              <input
                id={'history-ref-' + hold.id}
                name="evidenceRef"
                type="text"
                minLength={3}
                maxLength={300}
                required
                disabled={busy}
                placeholder="Contoh: ID ekspor riwayat portal atau catatan privat"
              />
            </div>
            <div>
              <label htmlFor={'resolution-note-' + hold.id}>Ringkasan keputusan</label>
              <textarea
                id={'resolution-note-' + hold.id}
                name="resolutionNote"
                minLength={10}
                maxLength={1000}
                required
                disabled={busy}
                placeholder="Ringkas cakupan yang dicocokkan dan hasil pemeriksaan."
              />
            </div>
            <label>
              <input type="checkbox" name="oldProcessStopped" required disabled={busy} />
              Proses lama dan sesi browser sudah dihentikan atau aksesnya dicabut.
            </label>
            <label>
              <input type="checkbox" name="externalActivityReviewed" required disabled={busy} />
              Seluruh aktivitas portal dalam jendela ini sudah diperiksa, termasuk yang hilang dari restore.
            </label>
            <label>
              <input type="checkbox" name="quotaReconciled" required disabled={busy} />
              Kuota sudah dicocokkan; hari dengan riwayat tidak lengkap tidak dilepas.
            </label>
            {message ? <p className="notice" role="status">{message}</p> : null}
            {error ? <p className="error" role="alert">{error}</p> : null}
            <button type="submit" disabled={busy || !attempts}>
              {busy ? 'Menyimpan…' : 'Lepas hold setelah pemeriksaan'}
            </button>
          </form>
        </div>
      ) : null}
    </li>
  );
}

export default function RecoveryHolds({
  holds,
  csrfToken,
}: {
  holds: DashboardRecoveryHold[];
  csrfToken: string;
}) {
  if (holds.length === 0) return null;
  return (
    <section className="panel" aria-labelledby="recovery-holds-title">
      <h2 id="recovery-holds-title">Recovery hold aktif</h2>
      <p className="muted">
        Hold menahan pengiriman baru sampai semua attempt dan aktivitas pada jendela pemulihan
        direkonsiliasi. Melepas hold tidak mengaktifkan browser submission.
      </p>
      <ul className="card-list">
        {holds.map((hold) => (
          <RecoveryHoldCard key={hold.id} hold={hold} csrfToken={csrfToken} />
        ))}
      </ul>
    </section>
  );
}
