"use client";

import { useEffect, useState } from "react";
import { useWorkspaceData } from "@/features/buckets/workspace-data-context";
import { defaultPaymentModes, type PaymentModeSettings } from "./payment-modes";

export function usePaymentModes(bucketId: string, enabled = true) {
  const { read, peek } = useWorkspaceData();
  const path = `buckets/${bucketId}/payment-modes`;
  const [settings, setSettings] = useState<PaymentModeSettings>(
    () => peek<PaymentModeSettings>(path)?.data ?? { modes: defaultPaymentModes, revision: 0 },
  );

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void read<PaymentModeSettings>(path).then(
      (result) => {
        if (active) setSettings(result.data);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [enabled, path, read]);

  return { settings, setSettings };
}
