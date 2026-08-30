import type { Context } from "hono";
import { parseRawDerivationSegments } from "../lib/derivation";

export type RawPathResolution =
  | { ok: true; path: string }
  | { ok: false; response: Response };

export const FAMILY_INFERENCE_HINT =
  "Cannot infer the network family from this path. The path must start with 44/60 (EVM) or 44/195 (TRON).";

// Extracts and canonicalizes the raw derivation path that follows `prefix` in
// the request URL, e.g. "/transaction/" + "44/60/0/0/5" -> "m/44/60/0/0/5".
export function extractRawDerivationPath(
  c: Context<any, string>,
  prefix: string
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

  return { ok: true, path: parsed.path };
}
