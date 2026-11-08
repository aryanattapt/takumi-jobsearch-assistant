import { jsonError } from '@/lib/http/respond';

/**
 * Route wrappers that convert domain errors into the documented JSON envelope.
 * Request IDs are echoed in both success and error responses.
 */
export function apiRoute(
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    try {
      return await handler(request);
    } catch (error) {
      return jsonError(request, error);
    }
  };
}

export function apiRouteCtx<Context>(
  handler: (request: Request, context: Context) => Promise<Response>,
): (request: Request, context: Context) => Promise<Response> {
  return async (request: Request, context: Context): Promise<Response> => {
    try {
      return await handler(request, context);
    } catch (error) {
      return jsonError(request, error);
    }
  };
}
