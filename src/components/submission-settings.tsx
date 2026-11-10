'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export interface SubmissionSettingsView {
  browserEnabled: boolean;
  canEnableBrowser: false;
  activationBlockers: string[];
  quotaTimezone: string;
  globalLimit: number;
  sourceLimits: Record<string, number>;
  policyVersion: number;
  version: number;
  updatedAt: string;
}

interface ApiEnvelope<T> {
  data?: T;
  error?: { code?: string; message?: string };
}

function sourceLimitsText(limits: Record<string, number>): string {
  return Object.entries(limits)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([source, limit]) => `${source}=${limit}`)
    .join('\n');
}

function parseSourceLimits(value: string): Record<string, number> {
  const limits: Record<string, number> = {};
  for (const [index, rawLine] of value.split('\n').entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator < 1 || line.indexOf('=', separator + 1) !== -1) {
      throw new Error(`Format baris ${index + 1} harus source=limit`);
    }
    const source = line.slice(0, separator).trim();
    const limitText = line.slice(separator + 1).trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(source)) {
      throw new Error(`Kode sumber pada baris ${index + 1} tidak valid`);
    }
    const limit = Number(limitText);
    if (!Number.isInteger(limit) || limit < 0 || limit > 1000) {
      throw new Error(`Limit pada baris ${index + 1} harus angka 0–1000`);
    }
    if (Object.hasOwn(limits, source)) throw new Error(`Sumber ${source} ditulis lebih dari sekali`);
    limits[source] = limit;
  }
  if (Object.keys(limits).length > 20) throw new Error('Maksimal 20 sumber dapat diatur');
  return limits;
}

export default function SubmissionSettings(props: {
  csrfToken: string;
  settings: SubmissionSettingsView;
}) {
  const router = useRouter();
  const [settings, setSettings] = useState(props.settings);
  const [timezone, setTimezone] = useState(props.settings.quotaTimezone);
  const [globalLimit, setGlobalLimit] = useState(String(props.settings.globalLimit));
  const [sourceLimits, setSourceLimits] = useState(sourceLimitsText(props.settings.sourceLimits));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const parsedGlobalLimit = Number(globalLimit);
      if (!Number.isInteger(parsedGlobalLimit) || parsedGlobalLimit < 0 || parsedGlobalLimit > 1000) {
        throw new Error('Batas global harus angka 0–1000');
      }
      const response = await fetch('/api/v1/submission-settings', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': props.csrfToken,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          quotaTimezone: timezone,
          globalLimit: parsedGlobalLimit,
          sourceLimits: parseSourceLimits(sourceLimits),
          expectedVersion: settings.version,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as ApiEnvelope<SubmissionSettingsView>;
      if (!response.ok || payload.error || !payload.data) {
        throw new Error(payload.error?.message ?? `Gagal menyimpan (${response.status})`);
      }
      setSettings(payload.data);
      setMessage('Pengaturan kuota tersimpan. Pengiriman browser tetap nonaktif.');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Gagal menyimpan pengaturan');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="submission-settings-title">
      <h2 id="submission-settings-title">Kontrol pengiriman</h2>
      <p>
        Submit browser: <strong>{settings.browserEnabled ? 'Aktif' : 'Nonaktif'}</strong>. Batas
        kuota di bawah ini baru disimpan sebagai kebijakan; belum ada reservasi atau pengiriman
        otomatis.
      </p>
      <ul className="muted">
        {settings.activationBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
      </ul>
      <div aria-live="polite">
        {message ? <p className="notice">{message}</p> : null}
        {error ? <p className="error" role="alert">{error}</p> : null}
      </div>
      <form onSubmit={save}>
        <div className="row">
          <div>
            <label htmlFor="quota-timezone">Zona waktu kuota</label>
            <input
              id="quota-timezone"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              maxLength={64}
              required
            />
            <small className="muted">Contoh: Asia/Jakarta</small>
          </div>
          <div>
            <label htmlFor="global-quota">Batas global per hari</label>
            <input
              id="global-quota"
              type="number"
              min={0}
              max={1000}
              value={globalLimit}
              onChange={(event) => setGlobalLimit(event.target.value)}
              required
            />
            <small className="muted">0 menahan semua pengiriman otomatis.</small>
          </div>
        </div>
        <div>
          <label htmlFor="source-quotas">Batas per sumber</label>
          <textarea
            id="source-quotas"
            rows={4}
            value={sourceLimits}
            onChange={(event) => setSourceLimits(event.target.value)}
            placeholder={'jobstreet=3\nglints=2'}
            aria-describedby="source-quotas-help"
          />
          <small id="source-quotas-help" className="muted">
            Satu kode sumber per baris dengan format source=limit. Maksimal 20 sumber.
          </small>
        </div>
        <button type="submit" disabled={busy}>
          {busy ? 'Menyimpan…' : 'Simpan kebijakan kuota'}
        </button>
        <span className="muted" style={{ marginLeft: 12 }}>
          Versi kebijakan {settings.policyVersion} · versi pengaturan {settings.version}
        </span>
      </form>
    </section>
  );
}
