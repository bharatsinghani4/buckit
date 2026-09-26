import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("mongoose", () => ({ default: { connect } }));

import { connectDatabase } from "./mongoose";

const connectionCache = globalThis as typeof globalThis & {
  buckitMongoConnection?: unknown;
};

beforeEach(() => {
  delete connectionCache.buckitMongoConnection;
  connect.mockReset();
  vi.stubEnv("MONGODB_URI", "mongodb://localhost:27017");
  vi.stubEnv("MONGODB_DB_NAME", "buckit-test");
});

afterEach(() => {
  delete connectionCache.buckitMongoConnection;
  vi.unstubAllEnvs();
});

describe("database connection lifecycle", () => {
  it("shares an in-flight connection across concurrent callers", async () => {
    let finish!: (connection: object) => void;
    connect.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );

    const first = connectDatabase();
    const second = connectDatabase();
    expect(first).toBe(second);
    expect(connect).toHaveBeenCalledTimes(1);
    finish({});
    await first;
    expect(connectDatabase()).toBe(first);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("retries after an initial connection failure instead of caching rejection", async () => {
    connect.mockRejectedValueOnce(new Error("Database unavailable")).mockResolvedValueOnce({});
    await expect(connectDatabase()).rejects.toThrow("Database unavailable");
    await expect(connectDatabase()).resolves.toEqual({});
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("does not attempt a connection with incomplete configuration", () => {
    vi.stubEnv("MONGODB_DB_NAME", "");
    expect(() => connectDatabase()).toThrow("Missing required configuration: MONGODB_DB_NAME");
    expect(connect).not.toHaveBeenCalled();
  });
});
