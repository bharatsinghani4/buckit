import { Suspense } from "react";
import { WorkspaceScreen } from "@/features/buckets/workspace-screen";
import { Pending } from "@/components/ui";
export default function Page() { return <Suspense fallback={<Pending />}><WorkspaceScreen /></Suspense>; }
