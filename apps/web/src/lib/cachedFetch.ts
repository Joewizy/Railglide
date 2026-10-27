/**
 * `fetch`, but remembered for a while — for answers that don't change second
 * to second (rate previews, bank lists). Switching back and forth between
 * chains or currencies reuses the answer instead of asking again.
 *
 * - Same URL + body within `ttlMs` → same response, no request.
 * - Two identical requests at once share one call.
 * - Errors aren't kept, so the next try asks again.
 *
 * Never use it for the real quote/order — those must always be fresh.
 */

const cache = new Map<string, { at: number; response: Promise<Response> }>();

export const ONE_MINUTE = 60_000;
export const ONE_HOUR = 60 * ONE_MINUTE;

export function cachedFetch(
  url: string,
  init: RequestInit = {},
  ttlMs = ONE_MINUTE
): Promise<Response> {
  const key = `${init.method ?? "GET"} ${url} ${String(init.body ?? "")}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) {
    return hit.response.then((res) => res.clone());
  }

  const response = fetch(url, init).then((res) => {
    if (!res.ok) cache.delete(key);
    return res;
  });
  response.catch(() => cache.delete(key));
  cache.set(key, { at: Date.now(), response });
  // Hand out copies so the cached one can be read again later.
  return response.then((res) => res.clone());
}
