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
});
