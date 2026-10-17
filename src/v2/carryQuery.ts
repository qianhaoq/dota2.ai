/**
 * Builds the query string carried over when navigating across routes.
 * Only `lang` (the current UI language) and `ff` (feature-flag override, when
 * present) survive — page-scoped params like `hero`, `claim`, `view` or `ask`
 * must never leak into a different route.
 */
export function buildCarryQuery(search: string, lang: string): string {
  const params = new URLSearchParams(search);
  const out = new URLSearchParams();
  out.set('lang', lang);
  const ff = params.get('ff');
  if (ff) out.set('ff', ff);
  return `?${out.toString()}`;
}
