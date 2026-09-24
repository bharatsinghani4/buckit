import Image from "next/image";
import Link from "next/link";
export function Wordmark() { return <span className="wordmark">buck<em>it</em></span>; }
export function Brand({ compact = false }: { compact?: boolean }) {
  return <Link href="/" className="brand" aria-label="Buckit home"><Image src="/buckit-mark.svg" width={36} height={36} alt="" priority />{!compact && <Wordmark />}</Link>;
}
