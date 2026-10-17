/**
 * Pick the user-facing text from a server error payload.
 *
 * LLM failures arrive as `{ error: 'ai_unavailable', message: '<localized>' }`
 * (see lib/llmErrors.js sanitizeLlmErrorForClient); older/generic endpoints
 * only carry `error`. Prefer the localized `message`, fall back to `error`,
 * then to the caller's default.
 */
export const serverErrorMessage = (data: unknown, fallback: string): string => {
  if (data && typeof data === 'object') {
    const { message, error } = data as { message?: unknown; error?: unknown };
    if (typeof message === 'string' && message.trim()) return message;
    if (typeof error === 'string' && error.trim()) return error;
  }
  return fallback;
};
