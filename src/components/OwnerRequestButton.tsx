import { OWNER_REQUEST, type OwnerRequestKind } from "@/lib/owner-request";
import { CopyButton } from "./CopyButton";

/** For a step only the office owner can do: copies what to ask and where,
 * for the person to pass on. Nothing is sent. */
export function OwnerRequestButton({ request }: { request: OwnerRequestKind }) {
  return <CopyButton text={OWNER_REQUEST[request]} label="Copy request for your owner"
    className="pm-control inline-flex items-center gap-1.5 rounded border border-line bg-sheet px-3 text-[13px] text-ink hover:bg-selected disabled:opacity-40" />;
}
