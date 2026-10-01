import { afterEach, describe, expect, it, vi } from "vitest";

const user = vi.hoisted(() => ({ uid: "member-1", getIdToken: vi.fn(async () => "test-token") }));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseClientAuth: () => ({ currentUser: user }) }));

import { api } from "./client";

afterEach(() => vi.unstubAllGlobals());

describe("API client requests", () => {
  it("shares simultaneous reads of the same resource, then allows a later refresh", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetcher);

    const first = api<unknown[]>("buckets");
    const second = api<unknown[]>("buckets");
    expect(first).toBe(second);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    finish(Response.json({ data: [], meta: {} }));
    await Promise.all([first, second]);

    const later = api<unknown[]>("buckets");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    finish(Response.json({ data: [], meta: {} }));
    await later;
  });

  it("does not combine writes with the same path", async () => {
    const fetcher = vi.fn(async () => Response.json({ data: {}, meta: {} }));
    vi.stubGlobal("fetch", fetcher);
    await Promise.all([
      api("me", { method: "PATCH", body: { theme: "dark" } }),
      api("me", { method: "PATCH", body: { theme: "dark" } }),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
