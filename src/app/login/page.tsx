'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const payload = (await response.json()) as {
        error?: { message?: string };
      };
      if (!response.ok) {
        setError(payload.error?.message ?? 'Login failed');
        return;
      }
      router.replace('/');
      router.refresh();
    } catch {
      setError('Network error; try again');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <main className="login-card">
        <h1>AI Job Search Assistant</h1>
        <p className="muted">Private, single-owner workspace. Sign in to continue.</p>
        <form className="panel" onSubmit={onSubmit} aria-describedby="login-error">
          <div style={{ marginBottom: 14 }}>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ marginBottom: 14 }}>
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              style={{ width: '100%' }}
            />
          </div>
          <button type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <p id="login-error" role="alert" className="error" style={{ minHeight: 24 }}>
            {error ?? ''}
          </p>
        </form>
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          The owner account is created only through the local CLI
          (<code>npm run provision-owner</code>). The web app cannot provision an owner.
        </p>
      </main>
    </div>
  );
}
