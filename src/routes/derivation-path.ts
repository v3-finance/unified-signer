import type { Context } from "hono";
import {
  parseRawDerivationSegments,
  pathFamilyConflict,
  type ChainFamily,
} from "../lib/derivation";

export type RawPathResolution =
  | { ok: true; path: string }
  | { ok: false; response: Response };

export const FAMILY_INFERENCE_HINT =
  "Cannot infer the network family from this path. Use a BIP44-shaped path (44/60/... or 44/195/...) or the network-scoped endpoints.";

// Extracts and canonicalizes the raw derivation path that follows `prefix` in
// the request URL, e.g. "/ethereum/transaction/" + "44/60/0/0/5" ->
// "m/44/60/0/0/5". When `family` is given, a BIP44-shaped path whose coin
// type contradicts it is rejected — deriving a tron-branch key for an EVM
// network is almost certainly a client mistake.
export function extractRawDerivationPath(
  c: Context<any, string>,
  prefix: string,
  family?: ChainFamily
): RawPathResolution {
  const pathname = c.req.path;
  const suffix = pathname.startsWith(prefix)
    ? pathname.slice(prefix.length)
    : "";
  const segments = suffix.split("/").filter((segment) => segment.length > 0);
  const parsed = parseRawDerivationSegments(segments);

  if (!parsed.ok) {
    return { ok: false, response: c.json({ error: parsed.error }, 400) };
  }

  if (family && pathFamilyConflict(parsed.path, family)) {
    return {
      ok: false,
      response: c.json(
        {
          error: `Derivation path coin type does not match the ${family} network family`,
          path: parsed.path,
        },
        400
      ),
    };
  }

  return { ok: true, path: parsed.path };
}
