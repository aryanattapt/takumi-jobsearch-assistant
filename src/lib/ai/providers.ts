import { z } from 'zod';
import type { PoolClient } from 'pg';
import { recordAudit } from '@/lib/audit';
import { getConfig } from '@/lib/config';
import { decryptSecret, encryptSecret } from '@/lib/crypto/secrets';
import { queryOne, withTransaction } from '@/lib/db/pool';
import { ApiError, apiErrors } from '@/lib/http/errors';

export type AiProviderType = 'openai_compatible';

export interface AiProviderSettings {
  id: string;
  type: AiProviderType;
  baseUrl: string;
  model: string;
  enabled: boolean;
  secretConfigured: boolean;
  lastTestedAt: Date | null;
  lastTestStatus: 'passed' | 'failed' | null;
  createdAt: Date;
  updatedAt: Date;
}

interface AiProviderRow {
  id: string;
  owner_id: string;
  type: AiProviderType;
  base_url: string | null;
  model: string;
  secret_ciphertext: Buffer | null;
  enabled: boolean;
  last_tested_at: Date | null;
  last_test_status: 'passed' | 'failed' | null;
  created_at: Date;
  updated_at: Date;
}

export interface ProviderUpdate {
  type: AiProviderType;
  baseUrl: string;
  model: string;
  apiKey?: string;
  enabled: boolean;
}

export interface ProviderCompletion {
  providerId: string;
  providerType: AiProviderType;
  content: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}

const ProviderResponseSchema = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({
    message: z.object({ content: z.string() }),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
  }).optional(),
});

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw apiErrors.invalidInput('Provider URL must be an absolute HTTPS URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw apiErrors.invalidInput('Provider URL must use HTTPS and cannot include credentials, query, or fragment');
  }
  const canonical = `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
  const allowed = getConfig().AI_ALLOWED_ENDPOINT_ORIGINS
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      try {
        const allowedUrl = new URL(item);
        return `${allowedUrl.origin}${allowedUrl.pathname.replace(/\/+$/u, '')}`;
      } catch {
        return '';
      }
    });
  if (!allowed.includes(canonical)) {
    throw apiErrors.invalidInput('Provider URL is not in AI_ALLOWED_ENDPOINT_ORIGINS');
  }
  return canonical;
}

function toSettings(row: AiProviderRow): AiProviderSettings {
  return {
    id: row.id,
    type: row.type,
    baseUrl: row.base_url ?? 'https://api.openai.com/v1',
    model: row.model,
    enabled: row.enabled,
    secretConfigured: Boolean(row.secret_ciphertext),
    lastTestedAt: row.last_tested_at,
    lastTestStatus: row.last_test_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getAiProvider(ownerId: string): Promise<AiProviderSettings | null> {
  const row = await queryOne<AiProviderRow>(
    'SELECT * FROM ai_providers WHERE owner_id = $1',
    [ownerId],
  );
  return row ? toSettings(row) : null;
}

export async function saveAiProvider(
  ownerId: string,
  input: ProviderUpdate,
  requestId?: string,
): Promise<AiProviderSettings> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const model = input.model.trim();
  if (!model || model.length > 200) throw apiErrors.invalidInput('Model name is required');
  if (input.apiKey !== undefined && (input.apiKey.trim().length < 8 || input.apiKey.length > 2048)) {
    throw apiErrors.invalidInput('API key must contain between 8 and 2048 characters');
  }

  return withTransaction(async (client) => {
    const current = await client.query<AiProviderRow>(
      'SELECT * FROM ai_providers WHERE owner_id = $1 FOR UPDATE',
      [ownerId],
    );
    const existing = current.rows[0];
    const secretCiphertext = input.apiKey
      ? encryptSecret(input.apiKey.trim())
      : existing?.secret_ciphertext ?? null;
    if (input.enabled && !secretCiphertext) {
      throw apiErrors.invalidInput('An API key is required before enabling the provider');
    }

    const changed = Boolean(
      !existing ||
      existing.type !== input.type ||
      existing.base_url !== baseUrl ||
      existing.model !== model ||
      input.apiKey !== undefined,
    );
    const saved = await client.query<AiProviderRow>(
      `INSERT INTO ai_providers
         (owner_id, type, base_url, model, secret_ciphertext, enabled,
          last_tested_at, last_test_status)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL)
       ON CONFLICT (owner_id) DO UPDATE
         SET type = EXCLUDED.type,
             base_url = EXCLUDED.base_url,
             model = EXCLUDED.model,
             secret_ciphertext = EXCLUDED.secret_ciphertext,
             enabled = EXCLUDED.enabled,
             last_tested_at = CASE WHEN $7 THEN NULL ELSE ai_providers.last_tested_at END,
             last_test_status = CASE WHEN $7 THEN NULL ELSE ai_providers.last_test_status END,
             updated_at = now()
       RETURNING *`,
      [ownerId, input.type, baseUrl, model, secretCiphertext, input.enabled, changed],
    );
    const row = saved.rows[0]!;
    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'ai_provider.updated',
      entityType: 'ai_provider',
      entityId: row.id,
      result: 'success',
      requestId: requestId ?? null,
      details: {
        type: row.type,
        model: row.model,
        enabled: row.enabled,
        secretConfigured: Boolean(row.secret_ciphertext),
      },
    });
    return toSettings(row);
  });
}

export async function runProviderTest(
  ownerId: string,
  requestId?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ passed: boolean; model: string; latencyMs: number }> {
  const row = await queryOne<AiProviderRow>(
    'SELECT * FROM ai_providers WHERE owner_id = $1',
    [ownerId],
  );
  if (!row || !row.secret_ciphertext) throw apiErrors.invalidInput('Configure an API key first');
  if (row.type !== 'openai_compatible') throw apiErrors.invalidInput('This provider adapter is not available yet');
  const started = Date.now();
  let passed = false;
  try {
    const completion = await requestProviderJson({
      baseUrl: normalizeBaseUrl(row.base_url ?? 'https://api.openai.com/v1'),
      apiKey: decryptSecret(row.secret_ciphertext),
      model: row.model,
      providerId: row.id,
      providerType: row.type,
      system: 'You are a connectivity check. Follow only this instruction.',
      user: 'Return exactly this JSON object: {"ok":true}.',
      fetchImpl,
    });
    const testResult = z.object({ ok: z.literal(true) }).safeParse(JSON.parse(completion.content));
    if (!testResult.success) throw new Error('PROVIDER_TEST_RESPONSE_INVALID');
    passed = true;
  } catch {
    passed = false;
  }
  const latencyMs = Date.now() - started;
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE ai_providers SET last_tested_at = now(), last_test_status = $2, updated_at = now()
        WHERE id = $1 AND owner_id = $3`,
      [row.id, passed ? 'passed' : 'failed', ownerId],
    );
    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'ai_provider.tested',
      entityType: 'ai_provider',
      entityId: row.id,
      result: passed ? 'success' : 'failure',
      requestId: requestId ?? null,
      details: { type: row.type, model: row.model, latencyMs },
    });
  });
  return { passed, model: row.model, latencyMs };
}

export async function completeStructuredJson(
  ownerId: string,
  messages: { system: string; user: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderCompletion> {
  const row = await queryOne<AiProviderRow>(
    'SELECT * FROM ai_providers WHERE owner_id = $1',
    [ownerId],
  );
  if (!row || !row.enabled || row.last_test_status !== 'passed' || !row.secret_ciphertext) {
    throw new ApiError(409, 'AI_PROVIDER_NOT_READY', 'AI provider must be enabled and pass its connection test');
  }
  if (row.type !== 'openai_compatible') throw apiErrors.invalidInput('This provider adapter is not available yet');
  return requestProviderJson({
    baseUrl: normalizeBaseUrl(row.base_url ?? 'https://api.openai.com/v1'),
    apiKey: decryptSecret(row.secret_ciphertext),
    model: row.model,
    providerId: row.id,
    providerType: row.type,
    ...messages,
    fetchImpl,
  });
}

async function requestProviderJson(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerId: string;
  providerType: AiProviderType;
  system: string;
  user: string;
  fetchImpl: typeof fetch;
}): Promise<ProviderCompletion> {
  const baseUrl = input.baseUrl.endsWith('/') ? input.baseUrl : `${input.baseUrl}/`;
  const url = new URL('chat/completions', baseUrl);
  const started = Date.now();
  let response: Response;
  try {
    response = await input.fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: input.model,
        temperature: 0,
        max_tokens: 1400,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
      }),
    });
  } catch {
    throw apiErrors.providerUnavailable('AI provider request failed or timed out');
  }
  if (!response.ok) throw apiErrors.providerUnavailable('AI provider rejected the request');
  const text = await response.text();
  if (text.length > 256 * 1024) throw apiErrors.providerUnavailable('AI provider response exceeded the size limit');
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw apiErrors.providerUnavailable('AI provider returned invalid JSON');
  }
  const parsed = ProviderResponseSchema.safeParse(payload);
  if (!parsed.success) throw apiErrors.providerUnavailable('AI provider returned an unsupported response');
  const content = parsed.data.choices[0]?.message.content;
  if (!content) throw apiErrors.providerUnavailable('AI provider returned an unsupported response');
  let resultJson: unknown;
  try {
    resultJson = JSON.parse(content);
  } catch {
    throw apiErrors.providerUnavailable('AI provider did not return structured JSON');
  }
  return {
    providerId: input.providerId,
    providerType: input.providerType,
    content: JSON.stringify(resultJson),
    model: parsed.data.model ?? input.model,
    inputTokens: parsed.data.usage?.prompt_tokens ?? null,
    outputTokens: parsed.data.usage?.completion_tokens ?? null,
    latencyMs: Date.now() - started,
  };
}

/** Test helper to make sure the provider API key never appears in persisted or public settings. */
export async function getProviderRowForTransaction(
  client: PoolClient,
  ownerId: string,
): Promise<AiProviderRow | null> {
  const result = await client.query<AiProviderRow>(
    'SELECT * FROM ai_providers WHERE owner_id = $1',
    [ownerId],
  );
  return result.rows[0] ?? null;
}
