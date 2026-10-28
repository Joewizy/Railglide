import Constants from "expo-constants";

/** The dev machine's host (e.g. "192.168.18.2") from Metro, without the port. */
function metroHost(): string | null {
  const hostUri =
    Constants.expoConfig?.hostUri ??
    // Fallback for older manifest shapes.
    (
      Constants as unknown as {
        manifest2?: { extra?: { expoGo?: { debuggerHost?: string } } };
      }
    ).manifest2?.extra?.expoGo?.debuggerHost;
  return hostUri ? hostUri.split(":")[0] : null;
}

const API_URL =
  process.env.EXPO_PUBLIC_API_URL ??
  (__DEV__ && metroHost()
    ? `http://${metroHost()}:3000`
    : "http://localhost:3000");

// Backend host (e.g. "192.168.1.20:3000") — the SIWE message's `domain`.
// Parsed by hand since RN has no reliable global URL.
export const API_HOST = API_URL.replace(/^https?:\/\//, "").replace(
  /\/.*$/,
  ""
);

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The parsed JSON error body, when there was one (e.g. { needsName }). */
    readonly data?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Typed JSON request against the backend. `path` is a route like "/api/chat". */
export async function apiFetch<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let data: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === "object")
        data = parsed as Record<string, unknown>;
    } catch {
      // not JSON
    }
    throw new ApiError(parseErrorBody(body, path, res.status), res.status, data);
  }

  return (await res.json()) as T;
}

/** Prefer `{ "error": "…" }` from API bodies; fall back to raw text / status. */
function parseErrorBody(body: string, path: string, status: number): string {
  if (body) {
    try {
      const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === "string" && parsed.error.trim()) {
        return parsed.error.trim();
      }
      if (typeof parsed.message === "string" && parsed.message.trim()) {
        return parsed.message.trim();
      }
    } catch {
      // not JSON — use the raw text below
    }
    return body;
  }
  return `Request to ${path} failed (${status})`;
}

export { API_URL };
