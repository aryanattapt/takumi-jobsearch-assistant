'use client';

import { useCallback, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export interface AnswerFact {
  id: string;
  type: string;
  value: unknown;
  verificationStatus: string;
}

export interface AnswerItem {
  id: string;
  question: string;
  questionKey: string;
  answer: string;
  verificationStatus: string;
  sourceFactIds: string[];
  sourceFacts: AnswerFact[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AnswerSuggestionView {
  status: 'suggested' | 'needs_review' | 'needs_user_input';
  reason: string;
  questionKey: string;
  similarity: number | null;
  answer: AnswerItem | null;
}

export interface AnswerBankProps {
  csrfToken: string;
  answers: AnswerItem[];
  facts: AnswerFact[];
}

interface ApiEnvelope<T> {
  data?: T;
  error?: { code?: string; message?: string };
}

async function callApi<T>(
  url: string,
  options: RequestInit & { csrf?: string },
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.csrf) headers.set('x-csrf-token', options.csrf);
  const response = await fetch(url, { ...options, headers });
  const payload = (await response.json().catch(() => ({}))) as ApiEnvelope<T>;
  if (!response.ok || payload.error) {
    throw new Error(payload.error?.message ?? `Request failed (${response.status})`);
  }
  return payload.data as T;
}

function factLabel(fact: AnswerFact): string {
  const value = typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value);
  return `${fact.type}: ${value}`;
}

export default function AnswerBank(props: AnswerBankProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState(props.answers);

  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [selectedFacts, setSelectedFacts] = useState<string[]>([]);

  const [suggestQuestion, setSuggestQuestion] = useState('');
  const [suggestion, setSuggestion] = useState<AnswerSuggestionView | null>(null);

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

  async function fetchAnswers(): Promise<void> {
    const result = await callApi<{ answers: AnswerItem[] }>('/api/v1/answer-bank', {
      method: 'GET',
    });
    setAnswers(result.answers);
  }

  async function createAnswer(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await run(async () => {
      await callApi('/api/v1/answer-bank', {
        method: 'POST',
        csrf: props.csrfToken,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          answer,
          sourceFactIds: selectedFacts,
        }),
      });
      setQuestion('');
      setAnswer('');
      setSelectedFacts([]);
      await fetchAnswers();
      setMessage('Jawaban disimpan terenkripsi sebagai belum diverifikasi.');
    });
  }

  async function patchAnswer(
    item: AnswerItem,
    body: Record<string, unknown>,
  ): Promise<void> {
    await run(async () => {
      await callApi(`/api/v1/answer-bank/${item.id}`, {
        method: 'PATCH',
        csrf: props.csrfToken,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, expectedVersion: item.version }),
      });
      await fetchAnswers();
      setMessage('Bank jawaban diperbarui.');
    });
  }

  async function editAnswer(item: AnswerItem): Promise<void> {
    const next = window.prompt('Jawaban baru:', item.answer);
    if (next === null) return;
    if (!next.trim()) {
      setError('Jawaban tidak boleh kosong.');
      return;
    }
    await patchAnswer(item, { answer: next.trim() });
  }

  async function askSuggestion(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await run(async () => {
      const result = await callApi<AnswerSuggestionView>(
        '/api/v1/answer-bank/suggest',
        {
          method: 'POST',
          csrf: props.csrfToken,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: suggestQuestion }),
        },
      );
      setSuggestion(result);
    });
  }

  return (
    <section className="panel" aria-labelledby="answers-title">
      <h2 id="answers-title">Bank jawaban screening</h2>
      <p className="muted">
        Jawaban disimpan terenkripsi dan hanya dipakai jika sudah diverifikasi. Pertanyaan
        sensitif, hukum, atau yang belum punya jawaban tepercaya selalu meminta input
        eksplisit; sistem tidak menebak.
      </p>

      <div aria-live="polite">
        {message ? <p className="notice">{message}</p> : null}
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <form onSubmit={createAnswer}>
        <div className="grid">
          <div>
            <label htmlFor="answer-question">Pertanyaan formulir</label>
            <input
              id="answer-question"
              type="text"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Contoh: Berapa tahun pengalaman TypeScript Anda?"
              required
              maxLength={1000}
            />
          </div>
          <div>
            <label htmlFor="answer-facts">Fakta sumber (boleh lebih dari satu)</label>
            <select
              id="answer-facts"
              multiple
              size={4}
              value={selectedFacts}
              onChange={(event) =>
                setSelectedFacts(
                  Array.from(event.target.selectedOptions, (option) => option.value),
                )
              }
            >
              {props.facts.map((fact) => (
                <option key={fact.id} value={fact.id}>
                  {factLabel(fact)} ({fact.verificationStatus})
                </option>
              ))}
            </select>
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <label htmlFor="answer-text">Jawaban</label>
          <textarea
            id="answer-text"
            rows={3}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            required
            maxLength={5000}
          />
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button type="submit" disabled={busy}>
            Simpan jawaban
          </button>
          <span className="muted">Jawaban baru berstatus belum diverifikasi.</span>
        </div>
      </form>

      {answers.length === 0 ? (
        <p className="muted" style={{ marginTop: 14 }}>
          Belum ada jawaban tersimpan.
        </p>
      ) : (
        <ul className="card-list" style={{ marginTop: 14 }}>
          {answers.map((item) => (
            <li key={item.id}>
              <div style={{ flex: 1, minWidth: 280 }}>
                <strong>{item.question}</strong>
                <p style={{ margin: '6px 0' }}>{item.answer}</p>
                <div className="row">
                  <span
                    className={`badge ${
                      item.verificationStatus === 'verified'
                        ? 'ok'
                        : item.verificationStatus === 'retracted'
                          ? 'bad'
                          : 'warn'
                    }`}
                  >
                    {item.verificationStatus}
                  </span>
                  <span className="muted" style={{ fontSize: '0.82rem' }}>
                    versi {item.version} · {item.sourceFacts.length} fakta sumber
                  </span>
                </div>
                {item.sourceFacts.length > 0 ? (
                  <div className="muted" style={{ fontSize: '0.82rem' }}>
                    Sumber: {item.sourceFacts.map(factLabel).join(' · ')}
                  </div>
                ) : null}
              </div>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                {item.verificationStatus !== 'verified' ? (
                  <button
                    onClick={() => patchAnswer(item, { verificationStatus: 'verified' })}
                    disabled={busy}
                  >
                    Verifikasi
                  </button>
                ) : null}
                <button
                  className="secondary"
                  onClick={() => editAnswer(item)}
                  disabled={busy}
                >
                  Koreksi
                </button>
                {item.verificationStatus !== 'retracted' ? (
                  <button
                    className="danger"
                    onClick={() => patchAnswer(item, { verificationStatus: 'retracted' })}
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

      <div style={{ marginTop: 18 }}>
        <h3>Saran jawaban</h3>
        <p className="muted">
          Uji pertanyaan formulir. Hasil <code>suggested</code> hanya untuk jawaban
          terverifikasi; pertanyaan sensitif selalu <code>needs_user_input</code>.
        </p>
        <form className="row" onSubmit={askSuggestion} style={{ alignItems: 'flex-end' }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <label htmlFor="suggest-question">Pertanyaan</label>
            <input
              id="suggest-question"
              type="text"
              value={suggestQuestion}
              onChange={(event) => setSuggestQuestion(event.target.value)}
              required
              maxLength={1000}
            />
          </div>
          <button type="submit" disabled={busy}>
            Minta saran
          </button>
        </form>

        {suggestion ? (
          <div className="notice">
            <strong>{suggestion.status}</strong> · {suggestion.reason}
            {suggestion.similarity !== null
              ? ` · kemiripan ${suggestion.similarity.toFixed(2)}`
              : ''}
            {suggestion.answer ? (
              <div>
                <p style={{ margin: '6px 0' }}>{suggestion.answer.answer}</p>
                <div className="muted" style={{ fontSize: '0.82rem' }}>
                  Sumber:{' '}
                  {suggestion.answer.sourceFacts.length > 0
                    ? suggestion.answer.sourceFacts.map(factLabel).join(' · ')
                    : 'tidak ada'}
                </div>
              </div>
            ) : (
              <p className="muted" style={{ margin: '6px 0 0' }}>
                Tidak ada jawaban yang boleh dipakai otomatis. Pemilik harus mengisi.
              </p>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
