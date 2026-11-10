'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface PublicAiProvider {
  id: string;
  type: 'openai_compatible' | 'gemini' | 'anthropic';
  baseUrl: string;
  model: string;
  enabled: boolean;
  secretConfigured: boolean;
  lastTestedAt: string | null;
  lastTestStatus: 'passed' | 'failed' | null;
}

interface Props {
  csrfToken: string;
  provider: PublicAiProvider | null;
}

interface ApiEnvelope<T> {
  data?: T;
  error?: { code?: string; message?: string };
}

async function callApi<T>(url: string, options: RequestInit & { csrf?: string }): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.csrf) headers.set('x-csrf-token', options.csrf);
  const response = await fetch(url, { ...options, headers });
  const payload = (await response.json().catch(() => ({}))) as ApiEnvelope<T>;
  if (!response.ok || payload.error) {
    throw new Error(payload.error?.message ?? `Request failed (${response.status})`);
  }
  return payload.data as T;
}

export default function AiProviderSettings({ csrfToken, provider }: Props) {
  const router = useRouter();
  const [type, setType] = useState<PublicAiProvider['type']>(provider?.type ?? 'openai_compatible');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? 'https://api.openai.com/v1');
  const [model, setModel] = useState(provider?.model ?? 'gpt-4o-mini');
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(provider?.enabled ?? false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<PublicAiProvider> {
    const result = await callApi<{ provider: PublicAiProvider }>('/api/v1/ai/provider', {
      method: 'PUT',
      csrf: csrfToken,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type,
        baseUrl,
        model,
        ...(apiKey ? { apiKey } : {}),
        enabled,
      }),
    });
    setApiKey('');
    return result.provider;
  }

  async function saveSettings(): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await save();
      setMessage(`Konfigurasi ${saved.model} tersimpan. API key hanya ditampilkan sebagai status terpasang.`);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Konfigurasi gagal disimpan');
    } finally {
      setBusy(false);
    }
  }

  async function testConnection(): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await save();
      const result = await callApi<{ passed: boolean; model: string; latencyMs: number }>(
        '/api/v1/ai/provider',
        { method: 'POST', csrf: csrfToken },
      );
      setMessage(
        result.passed
          ? `Tes berhasil: ${result.model} · ${result.latencyMs} ms. Tes hanya mengirim prompt pemeriksaan tetap, tanpa data profil.`
          : 'Tes gagal. Provider/model tidak merespons format yang diharapkan; tidak ada fallback otomatis.',
      );
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Tes provider gagal');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="ai-provider-title">
      <h2 id="ai-provider-title">Provider AI</h2>
      <p className="muted">
        Default mati. Menyimpan atau menguji konfigurasi tidak mengirim profil kandidat.
        Review AI hanya berjalan setelah Anda memilih fakta terverifikasi dan menyetujui
        pengiriman fakta itu bersama detail lowongan. Tidak ada provider cadangan otomatis.
      </p>
      <div aria-live="polite">
        {message ? <p className="notice">{message}</p> : null}
        {error ? <p className="error" role="alert">{error}</p> : null}
      </div>
      <div className="grid">
        <div>
          <label htmlFor="ai-provider-type">Provider</label>
          <select
            id="ai-provider-type"
            value={type}
            onChange={(event) => {
              const next = event.target.value as PublicAiProvider['type'];
              setType(next);
              setBaseUrl(next === 'anthropic'
                ? 'https://api.anthropic.com/v1'
                : next === 'gemini'
                  ? 'https://generativelanguage.googleapis.com/v1beta'
                  : 'https://api.openai.com/v1');
              setModel(next === 'openai_compatible' ? 'gpt-4o-mini' : '');
            }}
          >
            <option value="openai_compatible">OpenAI-compatible</option>
            <option value="gemini">Google Gemini</option>
            <option value="anthropic">Anthropic Claude</option>
          </select>
        </div>
        <div>
          <label htmlFor="ai-base-url">Base URL</label>
          <input id="ai-base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} maxLength={500} />
        </div>
        <div>
          <label htmlFor="ai-model">Model</label>
          <input id="ai-model" value={model} onChange={(event) => setModel(event.target.value)} maxLength={200} required placeholder="Model ID dari akun provider" />
        </div>
        <div>
          <label htmlFor="ai-api-key">API key {provider?.secretConfigured ? '(tersimpan; kosongkan untuk mempertahankan)' : ''}</label>
          <input
            id="ai-api-key"
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            maxLength={2048}
            placeholder={provider?.secretConfigured ? 'API key tersimpan' : 'Masukkan API key'}
          />
        </div>
        <div>
          <label htmlFor="ai-enabled">Status</label>
          <select id="ai-enabled" value={enabled ? 'enabled' : 'disabled'} onChange={(event) => setEnabled(event.target.value === 'enabled')}>
            <option value="disabled">Mati</option>
            <option value="enabled">Aktif setelah tes</option>
          </select>
        </div>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" disabled={busy} onClick={() => void saveSettings()}>Simpan konfigurasi</button>
        <button className="secondary" type="button" disabled={busy || (!apiKey && !provider?.secretConfigured)} onClick={() => void testConnection()}>
          Tes koneksi
        </button>
        <span className="muted">
          API key: {provider?.secretConfigured ? 'tersimpan terenkripsi' : 'belum diatur'}
          {provider?.lastTestStatus ? ` · tes ${provider.lastTestStatus}` : ''}
        </span>
      </div>
      <p className="muted" style={{ fontSize: '0.8rem' }}>
        Base URL harus HTTPS dan tercantum persis pada AI_ALLOWED_ENDPOINT_ORIGINS. Mengganti provider menghapus status tes; tes ulang memakai prompt tetap tanpa data profil.
      </p>
    </section>
  );
}
