export function createWorkspaceReadCache<T>(
  fetcher: (path: string) => Promise<T>,
  now: () => number = Date.now,
  ttl = 60_000,
) {
  const entries = new Map<string, { request: Promise<T>; expiresAt: number; value?: T }>();

  function read(path: string): Promise<T> {
    const cached = entries.get(path);
    if (cached && cached.expiresAt > now()) return cached.request;
    const request = fetcher(path);
    const entry = { request, expiresAt: now() + ttl, value: cached?.value };
    entries.set(path, entry);
    void request.then(
      (value) => {
        if (entries.get(path)?.request === request) entry.value = value;
      },
      () => {
        if (entries.get(path)?.request !== request) return;
        if (entry.value === undefined) entries.delete(path);
        else entry.expiresAt = 0;
      },
    );
    return request;
  }

  function peek(path: string): T | undefined {
    return entries.get(path)?.value;
  }

  function invalidate(prefix: string) {
    for (const key of entries.keys()) {
      if (key.startsWith(prefix)) entries.delete(key);
    }
  }

  return { read, peek, invalidate };
}
