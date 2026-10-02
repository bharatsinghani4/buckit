"use client";

import { createContext, useCallback, useContext, useRef, type ReactNode } from "react";
import { api } from "@/lib/api/client";
import { createWorkspaceReadCache } from "./workspace-read-cache";

type Result<T> = Awaited<ReturnType<typeof api<T>>>;
type WorkspaceData = {
  read: <T>(path: string) => Promise<Result<T>>;
  peek: <T>(path: string) => Result<T> | undefined;
  invalidate: (prefix: string) => void;
};

const Context = createContext<WorkspaceData | null>(null);

/** Keep immutable GET results while the workspace is mounted; mutations clear their bucket. */
export function WorkspaceDataProvider({ children }: { children: ReactNode }) {
  const cache = useRef(createWorkspaceReadCache((path) => api<unknown>(path)));
  const read = useCallback(<T,>(path: string): Promise<Result<T>> => {
    return cache.current.read(path) as Promise<Result<T>>;
  }, []);
  const peek = useCallback(<T,>(path: string): Result<T> | undefined => {
    return cache.current.peek(path) as Result<T> | undefined;
  }, []);
  const invalidate = useCallback((prefix: string) => {
    cache.current.invalidate(prefix);
  }, []);
  return <Context.Provider value={{ read, peek, invalidate }}>{children}</Context.Provider>;
}

export function useWorkspaceData() {
  const context = useContext(Context);
  if (!context) throw new Error("Workspace data provider is missing.");
  return context;
}
