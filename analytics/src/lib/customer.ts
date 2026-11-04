import { sha256Hex } from "@afs/shared";

/** Provider customer ids are stored only as a per-site salted hash (enough to link renewals). */
export const hashCustomer = async (siteId: string, provider: string, id: string) =>
  (await sha256Hex(`${siteId}|customer|${provider}|${id}`)).slice(0, 32);
