export function createWorkspaceReadCache<T>(
  fetcher: (path: string) => Promise<T>,
  now: () => number = Date.now,
  ttl = 60_000,
) {
  const entries = new Map<string, { request: Promise<T>; expiresAt: number }>();

  function read(path: string): Promise<T> {
    const cached = entries.get(path);
    if (cached && cached.expiresAt > now()) return cached.request;
    const request = fetcher(path);
    entries.set(path, { request, expiresAt: now() + ttl });
    void request.catch(() => {
      if (entries.get(path)?.request === request) entries.delete(path);
    });
    return request;
  }

  function invalidate(prefix: string) {
    for (const key of entries.keys()) {
      if (key.startsWith(prefix)) entries.delete(key);
    }
  }

  return { read, invalidate };
}
