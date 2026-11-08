import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { appOrigin } from '@/lib/config';
import { sha256Hex } from '@/lib/crypto/hash';
import { ApiError, apiErrors, toApiError } from '@/lib/http/errors';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requestId(request: Request): string {
  const supplied = request.headers.get('x-request-id');
  if (supplied && UUID_PATTERN.test(supplied)) return supplied;
  return randomUUID();
}

export function clientIpHash(request: Request): string {
  // Deployment behind a trusted tunnel/reverse proxy. The raw address is never
  // stored; only a hash is kept for throttling and audit correlation.
  const forwarded = request.headers.get('x-forwarded-for');
  const realIp = request.headers.get('x-real-ip');
  const raw = (forwarded?.split(',')[0] ?? realIp ?? 'unknown').trim();
  return sha256Hex(raw);
}

export function userAgentHash(request: Request): string {
  return sha256Hex(request.headers.get('user-agent') ?? 'unknown');
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (!origin) return; // Non-browser clients still need a valid CSRF token.
  const expected = appOrigin();
  if (origin.replace(/\/$/, '') !== expected) {
    throw apiErrors.forbidden('Origin is not allowed');
  }
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw apiErrors.forbidden('Cross-site request is not allowed');
  }
}

export function isMutation(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

export function jsonData(
  request: Request,
  data: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): NextResponse {
  return NextResponse.json(
    { data, meta: { requestId: requestId(request) } },
    { status: init.status ?? 200, headers: init.headers },
  );
}

export function jsonError(
  request: Request,
  error: unknown,
): NextResponse {
  const apiError = toApiError(error);
  const reqId = requestId(request);
  const headers: Record<string, string> = {};
  const retryAfter = apiError.details.retryAfterSeconds;
  if (typeof retryAfter === 'number') headers['Retry-After'] = String(retryAfter);
  if (apiError.status >= 500) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'api_error',
        requestId: reqId,
        code: apiError.code,
        message: apiError.message,
      }),
    );
  }
  return NextResponse.json(
    {
      error: {
        code: apiError.code,
        message: apiError.message,
        requestId: reqId,
        details: apiError.details,
      },
    },
    { status: apiError.status, headers },
  );
}

export function requireMethod(request: Request, allowed: string[]): void {
  if (!allowed.includes(request.method.toUpperCase())) {
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed', {
      allowed,
    });
  }
}
