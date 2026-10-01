import { Suspense } from "react";
import { AuthScreen } from "@/features/identity/auth-screen";
import { Pending } from "@/components/ui";
export default function Page() {
  return (
    <Suspense fallback={<Pending />}>
      <AuthScreen mode="forgot-password" />
    </Suspense>
  );
}
