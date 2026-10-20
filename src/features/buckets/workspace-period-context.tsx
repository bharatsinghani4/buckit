"use client";

import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { periodRange } from "@/features/insights/calculations";
import type { Expense } from "@/features/expenses/contracts";

type Period = "month" | "quarter" | "year" | "custom";
export type LedgerSnapshot = {
  loadedPath: string;
  query: string;
  status: string;
  appliedFilters: string;
  expenses: Expense[];
  cursor: string | null;
  scrollY: number;
};

type WorkspacePeriod = {
  period: Period;
  setPeriod: (period: Period) => void;
  anchor: string;
  setAnchor: (anchor: string) => void;
  customFrom: string;
  setCustomFrom: (from: string) => void;
  customTo: string;
  setCustomTo: (to: string) => void;
  month: string;
  ledgerAllDates: boolean;
  setMonth: (month: string) => void;
  clearMonth: () => void;
  range: { from: string; toExclusive: string };
  ledgerSnapshots: React.RefObject<Map<string, LedgerSnapshot>>;
};

const WorkspacePeriodContext = createContext<WorkspacePeriod | null>(null);

function nextDay(day: string) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function WorkspacePeriodProvider({ children }: { children: ReactNode }) {
  const ledgerSnapshots = useRef(new Map<string, LedgerSnapshot>());
  const [period, updatePeriod] = useState<Period>("month");
  const [anchor, updateAnchor] = useState(() => new Date().toISOString().slice(0, 10));
  const [ledgerAllDates, setLedgerAllDates] = useState(false);
  const [customFrom, setCustomFrom] = useState(() => `${new Date().toISOString().slice(0, 7)}-01`);
  const [customTo, setCustomTo] = useState(() => new Date().toISOString().slice(0, 10));
  const month = anchor.slice(0, 7);
  const setPeriod = (value: Period) => {
    updatePeriod(value);
    setLedgerAllDates(false);
  };
  const setAnchor = (value: string) => {
    updateAnchor(value);
    setLedgerAllDates(false);
  };
  const setMonth = (value: string) => {
    if (!value) return;
    setAnchor(`${value}-01`);
    setPeriod("month");
  };
  const clearMonth = () => {
    for (const snapshot of ledgerSnapshots.current.values()) {
      const filters = new URLSearchParams(snapshot.appliedFilters);
      filters.delete("from");
      filters.delete("toExclusive");
      snapshot.appliedFilters = filters.toString();
      snapshot.loadedPath = "";
    }
    setLedgerAllDates(true);
  };
  const range = useMemo(() => {
    if (period === "custom" && customFrom > customTo) return periodRange("month", anchor);
    return periodRange(period, anchor, customFrom || `${month}-01`, nextDay(customTo || anchor));
  }, [period, anchor, customFrom, customTo, month]);

  return (
    <WorkspacePeriodContext.Provider
      value={{
        period,
        setPeriod,
        anchor,
        setAnchor,
        customFrom,
        setCustomFrom,
        customTo,
        setCustomTo,
        month,
        ledgerAllDates,
        setMonth,
        clearMonth,
        range,
        ledgerSnapshots,
      }}
    >
      {children}
    </WorkspacePeriodContext.Provider>
  );
}

export function useWorkspacePeriod() {
  const context = useContext(WorkspacePeriodContext);
  if (!context) throw new Error("WorkspacePeriodProvider is missing.");
  return context;
}
