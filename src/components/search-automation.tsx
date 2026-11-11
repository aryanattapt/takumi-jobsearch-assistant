'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { DEFAULT_NOTIFICATION_TEMPLATE } from '@/lib/schedule/notification';

interface SavedSearchOption {
  id: string;
  name: string;
}

interface ScheduleItem {
  id: string;
  savedSearchId: string;
  savedSearchName: string;
  timezone: string;
  rule: { daysOfWeek: number[]; times: string[]; lateToleranceMinutes?: number };
  enabled: boolean;
  version: number;
  notifyInApp: boolean;
  notificationTemplate: string;
  lastRunStatus: string | null;
  lastRunCreatedAt: string | null;
  lastRunListingCount: number | null;
}

interface InboxItem {
  id: string;
  payload: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
}

interface ApiEnvelope<T> { data?: T; error?: { message?: string } }

const DAY_NAMES = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

async function api<T>(url: string, init?: RequestInit & { csrfToken?: string }): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.csrfToken) headers.set('x-csrf-token', init.csrfToken);
  const response = await fetch(url, { ...init, headers });
  const envelope = await response.json().catch(() => ({})) as ApiEnvelope<T>;
  if (!response.ok || envelope.error) throw new Error(envelope.error?.message ?? `Request failed (${response.status})`);
  return envelope.data as T;
}

export default function SearchAutomation(props: {
  csrfToken: string;
  timezone: string;
  savedSearches: SavedSearchOption[];
}) {
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [notifications, setNotifications] = useState<InboxItem[]>([]);
  const [savedSearchId, setSavedSearchId] = useState(props.savedSearches[0]?.id ?? '');
  const [timezone, setTimezone] = useState(props.timezone || 'Asia/Jakarta');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [times, setTimes] = useState('09:00');
  const [notifyInApp, setNotifyInApp] = useState(true);
  const [notificationTemplate, setNotificationTemplate] = useState(DEFAULT_NOTIFICATION_TEMPLATE);
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [scheduleResult, notificationResult] = await Promise.all([
      api<{ schedules: ScheduleItem[] }>('/api/v1/schedules'),
      api<{ notifications: InboxItem[] }>('/api/v1/notifications'),
    ]);
    setSchedules(scheduleResult.schedules);
    setNotifications(notificationResult.notifications);
  }, []);

  useEffect(() => {
    void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : 'Gagal memuat otomasi pencarian'));
  }, [refresh]);

  async function perform(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Aksi gagal');
    } finally {
      setBusy(false);
    }
  }

  async function createSchedule(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const parsedTimes = [...new Set(times.split(',').map((value) => value.trim()).filter(Boolean))];
    if (!savedSearchId || days.length === 0 || parsedTimes.length === 0) {
      setError('Pilih saved search, minimal satu hari, dan waktu pencarian.');
      return;
    }
    await perform(async () => {
      const editing = schedules.find((item) => item.id === editingScheduleId);
      await api(editing ? `/api/v1/schedules/${editing.id}` : '/api/v1/schedules', {
        method: editing ? 'PATCH' : 'POST', csrfToken: props.csrfToken,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          savedSearchId, timezone, rule: { daysOfWeek: days, times: parsedTimes, lateToleranceMinutes: 15 },
          enabled: editing?.enabled ?? true, notifyInApp,
          notificationTemplate,
          ...(editing ? { expectedVersion: editing.version } : {}),
        }),
      });
      setEditingScheduleId(null);
      setMessage(editing ? 'Jadwal diperbarui.' : 'Jadwal pencarian dibuat. Jadwal hanya mencari di katalog lowongan yang sudah tersimpan.');
    });
  }

  function editSchedule(schedule: ScheduleItem): void {
    setEditingScheduleId(schedule.id);
    setSavedSearchId(schedule.savedSearchId);
    setTimezone(schedule.timezone);
    setDays(schedule.rule.daysOfWeek);
    setTimes(schedule.rule.times.join(', '));
    setNotifyInApp(schedule.notifyInApp);
    setNotificationTemplate(schedule.notificationTemplate || DEFAULT_NOTIFICATION_TEMPLATE);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function toggleSchedule(schedule: ScheduleItem): Promise<void> {
    await perform(async () => {
      await api(`/api/v1/schedules/${schedule.id}`, {
        method: 'PATCH', csrfToken: props.csrfToken,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !schedule.enabled, expectedVersion: schedule.version }),
      });
      setMessage(schedule.enabled ? 'Jadwal dijeda.' : 'Jadwal diaktifkan.');
    });
  }

  async function removeSchedule(schedule: ScheduleItem): Promise<void> {
    if (!window.confirm(`Hapus jadwal “${schedule.savedSearchName}”? Riwayat run dan notifikasi yang terkait tetap mengikuti kebijakan retensi database.`)) return;
    await perform(async () => {
      await api(`/api/v1/schedules/${schedule.id}`, { method: 'DELETE', csrfToken: props.csrfToken });
      setMessage('Jadwal dihapus.');
    });
  }

  async function markRead(item: InboxItem): Promise<void> {
    await perform(async () => {
      await api(`/api/v1/notifications/${item.id}`, { method: 'PATCH', csrfToken: props.csrfToken });
    });
  }

  return (
    <section className="panel" aria-labelledby="search-automation-title">
      <h2 id="search-automation-title">Jadwal pencarian</h2>
      <p className="muted">
        Pencarian berkala menjalankan filter saved search pada katalog lowongan lokal. Sistem belum mengambil lowongan baru dari situs eksternal.
      </p>
      <div aria-live="polite">
        {message ? <p className="notice">{message}</p> : null}
        {error ? <p className="error" role="alert">{error}</p> : null}
      </div>
      {props.savedSearches.length ? (
        <form onSubmit={(event) => void createSchedule(event)}>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <label htmlFor="automation-search">Saved search</label>
              <select id="automation-search" value={savedSearchId} onChange={(event) => setSavedSearchId(event.target.value)}>
                {props.savedSearches.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </div>
            <div style={{ minWidth: 180 }}>
              <label htmlFor="automation-timezone">Zona waktu IANA</label>
              <input id="automation-timezone" value={timezone} maxLength={100} onChange={(event) => setTimezone(event.target.value)} />
            </div>
            <div style={{ minWidth: 200, flex: 1 }}>
              <label htmlFor="automation-times">Waktu lokal (HH:mm, pisahkan koma)</label>
              <input id="automation-times" value={times} maxLength={250} onChange={(event) => setTimes(event.target.value)} placeholder="09:00, 17:00" />
            </div>
          </div>
          <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: '10px 0' }}>
            <legend>Hari aktif</legend>
            <div className="row">
              {DAY_NAMES.map((name, day) => <label key={name} style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                <input type="checkbox" checked={days.includes(day)} onChange={(event) => setDays((current) => event.target.checked
                  ? [...new Set([...current, day])].sort((a, b) => a - b)
                  : current.filter((value) => value !== day))} />{name}
              </label>)}
            </div>
          </fieldset>
          <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', margin: '4px 0 12px' }}>
            <input type="checkbox" checked={notifyInApp} onChange={(event) => setNotifyInApp(event.target.checked)} />
            Beri notifikasi untuk lowongan baru atau revisi
          </label>
          <label htmlFor="automation-notification-template">Format isi notifikasi</label>
          <textarea
            id="automation-notification-template"
            rows={2}
            maxLength={300}
            value={notificationTemplate}
            onChange={(event) => setNotificationTemplate(event.target.value)}
          />
          <p className="muted" style={{ fontSize: '0.8rem' }}>
            Variabel: {'{{type}}'}, {'{{title}}'}, {'{{company}}'}, {'{{location}}'}, {'{{source}}'}, {'{{searchName}}'}, {'{{url}}'}. Penerima adalah pemilik workspace di inbox dashboard.
          </p>
          <div className="row">
            <button type="submit" disabled={busy}>{editingScheduleId ? 'Simpan perubahan' : 'Buat jadwal'}</button>
            {editingScheduleId ? <button type="button" className="secondary" disabled={busy} onClick={() => setEditingScheduleId(null)}>Batal edit</button> : null}
          </div>
        </form>
      ) : <p className="muted">Simpan filter pencarian terlebih dahulu untuk membuat jadwal.</p>}

      <h3 style={{ marginTop: 20 }}>Jadwal tersimpan</h3>
      {schedules.length ? <ul className="card-list">
        {schedules.map((schedule) => <li key={schedule.id}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <strong>{schedule.savedSearchName}</strong>
            <div className="muted">{schedule.enabled ? 'Aktif' : 'Dijeda'} · {schedule.rule.daysOfWeek.map((day) => DAY_NAMES[day]).join(', ')} · {schedule.rule.times.join(', ')} · {schedule.timezone}</div>
            <div className="muted">Run terakhir: {schedule.lastRunStatus ?? 'belum pernah'}{schedule.lastRunCreatedAt ? ` · ${new Date(schedule.lastRunCreatedAt).toLocaleString('id-ID')} · ${schedule.lastRunListingCount ?? 0} listing` : ''}</div>
          </div>
          <button type="button" className="secondary" disabled={busy} onClick={() => void toggleSchedule(schedule)}>{schedule.enabled ? 'Jeda' : 'Aktifkan'}</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => editSchedule(schedule)}>Edit</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => void removeSchedule(schedule)}>Hapus</button>
        </li>)}
      </ul> : <p className="muted">Belum ada jadwal.</p>}

      <h3 style={{ marginTop: 20 }}>Inbox notifikasi</h3>
      {notifications.length ? <ul className="card-list">
        {notifications.map((item) => {
          const title = typeof item.payload.title === 'string' ? item.payload.title : 'Lowongan diperbarui';
          const company = typeof item.payload.company === 'string' ? item.payload.company : '';
          const searchName = typeof item.payload.savedSearchName === 'string' ? item.payload.savedSearchName : 'saved search';
          const messageText = typeof item.payload.message === 'string' ? item.payload.message : null;
          const url = typeof item.payload.url === 'string' && /^https?:\/\//u.test(item.payload.url) ? item.payload.url : null;
          return <li key={item.id}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <strong>{messageText ?? `${String(item.payload.type ?? 'update').replaceAll('_', ' ')}: ${title}`}</strong>
              <div>{company} · {searchName}</div>
              <span className="muted">{new Date(item.createdAt).toLocaleString('id-ID')}{item.readAt ? ' · dibaca' : ' · baru'}</span>
              {url ? <div><a href={url} target="_blank" rel="noopener noreferrer">Buka listing</a></div> : null}
            </div>
            {!item.readAt ? <button type="button" className="secondary" disabled={busy} onClick={() => void markRead(item)}>Tandai dibaca</button> : null}
          </li>;
        })}
      </ul> : <p className="muted">Belum ada notifikasi. Perbandingan mulai setelah run terjadwal pertama.</p>}
    </section>
  );
}
