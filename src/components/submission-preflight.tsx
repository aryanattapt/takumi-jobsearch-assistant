'use client';

import { useEffect, useState } from 'react';

interface Snapshot {
  id: string;
  listingId: string;
  formFingerprint: string;
  snapshotHash: string;
  applicationVersion: number;
  adapterId: string;
  capturedAt: string;
  validUntil: string;
  content: {
    form: { fields: Array<{ name: string; required: boolean }> };
    materials: {
      documents: Array<{
        id: string;
        kind: string;
        versionNo: number;
        pdfStatus: string;
        documentStatus: string;
        reviewedAt: string | null;
      }>;
      answers: Array<{ id: string; version: number; verificationStatus: string }>;
      facts: Array<{ versionId: string; current: boolean; verified: boolean }>;
    };
    candidateFacts: Array<{ factId: string; versionId: string; valueHash: string }>;
    readiness: { ready: boolean; blockers: string[] };
  };
}

interface Review {
  snapshot: Snapshot | null;
  current: boolean;
  approval: {
    id: string;
    status: 'active' | 'expired' | 'revoked' | 'stale';
    expiresAt: string;
  } | null;
}

interface ApiEnvelope<T> {
  data?: T;
  error?: { code?: string; message?: string };
}

async function callApi<T>(
  url: string,
  options: RequestInit & { csrf?: string; idempotencyKey?: string } = {},
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

function blockerLabel(code: string): string {
  const labels: Record<string, string> = {
    LISTING_NOT_ACTIVE: 'Listing tidak berstatus aktif.',
    CV_REQUIRED: 'Belum ada CV untuk lamaran ini.',
    DOCUMENT_UNAVAILABLE: 'Ada dokumen yang tidak tersedia.',
    PDF_CHECK_FAILED: 'Pemeriksaan PDF gagal.',
    DOCUMENT_NOT_REVIEWED: 'Tinjau versi dokumen terbaru terlebih dahulu.',
    ANSWER_REQUIRES_OWNER_INPUT: 'Ada pertanyaan yang memerlukan jawaban Anda.',
    ANSWER_NOT_VERIFIED: 'Verifikasi semua jawaban yang akan disertakan.',
    FACT_NOT_CURRENT_OR_VERIFIED: 'Fakta sumber dokumen/jawaban sudah berubah atau belum terverifikasi.',
  };
  return labels[code] ?? code;
}

export interface SubmissionPreflightProps {
  csrfToken: string;
  applicationId: string;
  applicationVersion: number;
  listingId: string | null;
  onChanged: () => Promise<void>;
}

export default function SubmissionPreflight(props: SubmissionPreflightProps) {
  const [version, setVersion] = useState(props.applicationVersion);
  const [review, setReview] = useState<Review | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => setVersion(props.applicationVersion), [props.applicationVersion]);

  async function loadReview(): Promise<void> {
    const result = await callApi<Review>(
      `/api/v1/applications/${props.applicationId}/review`,
    );
    setReview(result);
    setLoaded(true);
  }

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
      await props.onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Aksi gagal');
    } finally {
      setBusy(false);
    }
  }

  async function createPreflight(): Promise<void> {
    if (!props.listingId) {
      setError('Listing aktif tidak ditemukan untuk lamaran ini.');
      return;
    }
    await run(async () => {
      const result = await callApi<{ snapshot: Snapshot; applicationVersion: number }>(
        `/api/v1/applications/${props.applicationId}/preflights`,
        {
          method: 'POST',
          csrf: props.csrfToken,
          idempotencyKey: crypto.randomUUID(),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ listingId: props.listingId, expectedVersion: version }),
        },
      );
      setVersion(result.applicationVersion);
      setReview({ snapshot: result.snapshot, current: true, approval: null });
      setLoaded(true);
      setMessage('Snapshot lokal dibuat. Tidak ada browser atau jaringan portal yang dibuka.');
    });
  }

  async function approve(): Promise<void> {
    const snapshot = review?.snapshot;
    if (!snapshot) return;
    const confirmed = window.confirm(
      'Setujui snapshot fixture lokal ini? Approval hanya menguji alur review dan tidak mengizinkan pengiriman ke portal nyata.',
    );
    if (!confirmed) return;
    await run(async () => {
      const result = await callApi<{
        approval: Review['approval'];
        applicationVersion: number;
      }>(`/api/v1/applications/${props.applicationId}/approvals`, {
        method: 'POST',
        csrf: props.csrfToken,
        idempotencyKey: crypto.randomUUID(),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          snapshotId: snapshot.id,
          snapshotHash: snapshot.snapshotHash,
          expectedVersion: version,
        }),
      });
      setVersion(result.applicationVersion);
      setReview((current) => current
        ? { ...current, approval: result.approval }
        : current);
      setMessage('Snapshot fixture disetujui. Dispatch portal nyata tetap nonaktif.');
    });
  }

  async function dryRun(): Promise<void> {
    const snapshot = review?.snapshot;
    if (!snapshot) return;
    await run(async () => {
      await callApi(`/api/v1/applications/${props.applicationId}/dry-runs`, {
        method: 'POST',
        csrf: props.csrfToken,
        idempotencyKey: crypto.randomUUID(),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshotId: snapshot.id, snapshotHash: snapshot.snapshotHash }),
      });
      setMessage('Dry-run lokal selesai sebagai simulated; tidak ada data dikirim dan kuota tidak dipakai.');
    });
  }

  async function revokeApproval(): Promise<void> {
    const approval = review?.approval;
    if (!approval || approval.status !== 'active') return;
    const confirmed = window.confirm(
      'Cabut approval fixture ini? Snapshot akan menjadi tidak berlaku dan perlu dibuat ulang sebelum review berikutnya.',
    );
    if (!confirmed) return;
    await run(async () => {
      const result = await callApi<{
        approval: NonNullable<Review['approval']>;
        applicationVersion: number;
      }>(`/api/v1/approvals/${approval.id}/revoke`, {
        method: 'POST',
        csrf: props.csrfToken,
        idempotencyKey: crypto.randomUUID(),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: version }),
      });
      setVersion(result.applicationVersion);
      setReview((current) => current
        ? { ...current, current: false, approval: result.approval }
        : current);
      setMessage('Approval dicabut; snapshot lama tidak dapat dipakai lagi.');
    });
  }

  return (
    <details
      style={{ marginTop: 10 }}
      onToggle={(event) => {
        if (event.currentTarget.open && !loaded) {
          void loadReview().catch((cause) => {
            setError(cause instanceof Error ? cause.message : 'Preflight gagal dimuat');
          });
        }
      }}
    >
      <summary>Portal Assist lokal · fixture saja</summary>
      <p className="muted" style={{ fontSize: '0.82rem' }}>
        Mode ini hanya membuat snapshot dan attempt simulasi di database lokal. Tidak membuka
        browser, memakai cookie, menghubungi portal, mengirim data kandidat, atau menekan submit.
      </p>
      <div className="row">
        <button type="button" disabled={busy || !props.listingId} onClick={() => void createPreflight()}>
          Buat preflight lokal
        </button>
        {review?.snapshot?.content.readiness.ready && review.current ? (
          <>
            <button type="button" className="secondary" disabled={busy} onClick={() => void dryRun()}>
              Jalankan dry-run
            </button>
            {!review.approval || review.approval.status !== 'active' ? (
              <button type="button" className="secondary" disabled={busy} onClick={() => void approve()}>
                Setujui snapshot fixture
              </button>
            ) : null}
            {review.approval?.status === 'active' ? (
              <button type="button" className="secondary" disabled={busy} onClick={() => void revokeApproval()}>
                Cabut approval
              </button>
            ) : null}
          </>
        ) : null}
      </div>
      <div aria-live="polite">
        {message ? <p className="notice">{message}</p> : null}
        {error ? <p className="error" role="alert">{error}</p> : null}
      </div>
      {review?.snapshot ? (
        <div style={{ marginTop: 10 }}>
          <div className="row">
            <span className={`badge ${review.snapshot.content.readiness.ready && review.current ? 'ok' : 'warn'}`}>
              {review.current
                ? review.snapshot.content.readiness.ready ? 'siap direview' : 'terblokir'
                : 'snapshot stale'}
            </span>
            <span className="muted">{review.snapshot.adapterId} · berlaku sampai {new Date(review.snapshot.validUntil).toLocaleString('id-ID')}</span>
          </div>
          <p className="muted" style={{ fontSize: '0.8rem', overflowWrap: 'anywhere' }}>
            Fingerprint form: {review.snapshot.formFingerprint}<br />
            Hash snapshot: {review.snapshot.snapshotHash}
          </p>
          {review.snapshot.content.readiness.blockers.length ? (
            <ul>
              {review.snapshot.content.readiness.blockers.map((blocker) => (
                <li key={blocker}>{blockerLabel(blocker)}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              Terikat ke {review.snapshot.content.materials.documents.length} versi dokumen,
              {' '}{review.snapshot.content.materials.answers.length} jawaban dan
              {' '}{review.snapshot.content.materials.facts.length} versi fakta sumber;
              {' '}{review.snapshot.content.candidateFacts.length} fakta kandidat terikat hash.
            </p>
          )}
          {review.approval ? (
            <p className="muted">Approval {review.approval.status} · berlaku sampai {new Date(review.approval.expiresAt).toLocaleString('id-ID')}</p>
          ) : null}
        </div>
      ) : loaded ? (
        <p className="muted">Belum ada snapshot preflight.</p>
      ) : null}
    </details>
  );
}
