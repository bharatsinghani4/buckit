import { describe, expect, it, vi } from "vitest";
import { createWorkspaceReadCache } from "./workspace-read-cache";

describe("workspace read cache", () => {
  it("reuses a completed read across section changes and refetches after invalidation", async () => {
    const fetcher = vi.fn(async (path: string) => ({ path, revision: 1 }));
    const cache = createWorkspaceReadCache(fetcher);

    await cache.read("buckets/a/members");
    await cache.read("buckets/a/members");
    expect(fetcher).toHaveBeenCalledTimes(1);

    cache.invalidate("buckets/a/");
    await cache.read("buckets/a/members");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("expires old results and retries a failed read", async () => {
    let clock = 0;
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue("ok");
    const cache = createWorkspaceReadCache(fetcher, () => clock, 100);

    await expect(cache.read("buckets/a/expenses")).rejects.toThrow("offline");
    expect(await cache.read("buckets/a/expenses")).toBe("ok");
    clock = 101;
    expect(await cache.read("buckets/a/expenses")).toBe("ok");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("exposes a completed snapshot while revalidating and clears it after a mutation", async () => {
    let clock = 0;
    let resolveNext!: (value: string) => void;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce("first")
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveNext = resolve;
          }),
      );
    const cache = createWorkspaceReadCache(fetcher, () => clock, 100);

    expect(cache.peek("buckets/a/expenses")).toBeUndefined();
    await cache.read("buckets/a/expenses");
    expect(cache.peek("buckets/a/expenses")).toBe("first");
    clock = 101;
    const revalidation = cache.read("buckets/a/expenses");
    expect(cache.peek("buckets/a/expenses")).toBe("first");
    resolveNext("second");
    await revalidation;
    expect(cache.peek("buckets/a/expenses")).toBe("second");
    cache.invalidate("buckets/a/");
    expect(cache.peek("buckets/a/expenses")).toBeUndefined();
  });

  it("invalidates one reference list without refetching unrelated workspace data", async () => {
    const fetcher = vi.fn(async (path: string) => path);
    const cache = createWorkspaceReadCache(fetcher);

    await Promise.all([
      cache.read("buckets/a/accounts"),
      cache.read("buckets/a/accounts?state=all"),
      cache.read("buckets/a/categories"),
      cache.read("buckets/a/expenses"),
    ]);
    cache.invalidate("buckets/a/accounts");

    expect(cache.peek("buckets/a/accounts")).toBeUndefined();
    expect(cache.peek("buckets/a/accounts?state=all")).toBeUndefined();
    expect(cache.peek("buckets/a/categories")).toBe("buckets/a/categories");
    expect(cache.peek("buckets/a/expenses")).toBe("buckets/a/expenses");

    await Promise.all([
      cache.read("buckets/a/accounts"),
      cache.read("buckets/a/categories"),
      cache.read("buckets/a/expenses"),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
});
