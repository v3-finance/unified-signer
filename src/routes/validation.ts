import type { Context } from "hono";
import type { z } from "zod";
import type { Env } from "../env";

// Manual body validation for endpoints whose schema depends on runtime state
// (e.g. the chain family inferred from the URL path); mirrors validationHook's
// error shape.
export async function parseJsonBodyOr400<Schema extends z.ZodTypeAny>(
  c: Context<Env, string>,
  schema: Schema
): Promise<
  | { ok: true; data: z.output<Schema> }
  | { ok: false; response: Response }
> {
  let raw: unknown;

  try {
    raw = await c.req.json();
  } catch {
    return {
      ok: false,
      response: c.json(
        { error: "Request body must be valid JSON", retryable: false },
        400
      ),
    };
  }

  const result = schema.safeParse(raw);

  if (!result.success) {
    return {
      ok: false,
      response: c.json(
        {
          error: "Validation Error",
          details: result.error.issues,
          retryable: false,
        },
        400
      ),
    };
  }

  return { ok: true, data: result.data as z.output<Schema> };
}
