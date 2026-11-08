export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const apiErrors = {
  unauthenticated: () =>
    new ApiError(401, 'UNAUTHENTICATED', 'A valid session is required'),
  forbidden: (message = 'Not allowed') => new ApiError(403, 'FORBIDDEN', message),
  notFound: () => new ApiError(404, 'NOT_FOUND', 'Resource not found'),
  invalidInput: (message = 'Invalid request input') =>
    new ApiError(400, 'INVALID_INPUT', message),
  validation: (details: Record<string, unknown>) =>
    new ApiError(422, 'VALIDATION_ERROR', 'Request failed validation', details),
  versionConflict: () =>
    new ApiError(409, 'VERSION_CONFLICT', 'The resource changed; reload and retry'),
  idempotencyConflict: () =>
    new ApiError(
      409,
      'IDEMPOTENCY_CONFLICT',
      'This Idempotency-Key was already used with a different payload',
    ),
  quotaExceeded: () =>
    new ApiError(429, 'QUOTA_EXCEEDED', 'Submission quota for today is exhausted'),
  rateLimited: (retryAfterSeconds: number) =>
    new ApiError(429, 'RATE_LIMITED', 'Too many attempts; try again later', {
      retryAfterSeconds,
    }),
  documentInUse: () =>
    new ApiError(
      409,
      'DOCUMENT_IN_USE',
      'The document is used by an active submission attempt',
    ),
  insufficientEvidence: (message = 'Evidence is not sufficient') =>
    new ApiError(422, 'INSUFFICIENT_EVIDENCE', message),
  providerUnavailable: (message = 'External provider is unavailable') =>
    new ApiError(502, 'PROVIDER_UNAVAILABLE', message),
  internal: () => new ApiError(500, 'INTERNAL_ERROR', 'Internal server error'),
  configuration: (message: string) =>
    new ApiError(500, 'CONFIGURATION_ERROR', message),
};

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error) {
    if (error.name === 'SecretConfigurationError') {
      return apiErrors.configuration(error.message);
    }
    const pgCode = (error as { code?: string }).code;
    if (pgCode === '23505') {
      return new ApiError(409, 'CONFLICT', 'The resource already exists');
    }
    if (pgCode === '23503') {
      return new ApiError(422, 'INVALID_REFERENCE', 'A referenced resource is missing');
    }
  }
  return apiErrors.internal();
}
