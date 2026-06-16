export async function fetchJsonWithTimeout<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let data: T | null = null;
    try {
      data = text ? (JSON.parse(text) as T) : null;
    } catch {
      // Keep data null and report text below.
    }
    const error =
      data && typeof data === "object" && "error" in data
        ? typeof (data as { error: unknown }).error === "object"
          ? JSON.stringify((data as { error: unknown }).error)
          : String((data as { error: unknown }).error)
        : text;
    return { ok: res.ok, status: res.status, data, error: res.ok ? undefined : error };
  } catch (error) {
    return { ok: false, status: 0, data: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}
