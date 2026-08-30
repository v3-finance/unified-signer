import type { Context } from "hono";
import type { z, ZodError } from "zod";
import type { Env } from "../env";

// Default zValidator failures return a raw ZodError dump; this hook produces
// the documented `{error: "Validation Error", details}` shape instead.
// The context is typed loosely because zValidator's Hook type is
// contravariant in the context parameter.
export function validationHook(
  result: { success: boolean; error?: unknown },
  c: Context<any, string>
) {
  if (!result.success) {
    const error = result.error as ZodError | undefined;
    return c.json(
      {
        error: "Validation Error",
        details: error?.issues ?? [],
      },
      400
    );
  }
}

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
      response: c.json({ error: "Request body must be valid JSON" }, 400),
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
        },
        400
      ),
    };
  }

  return { ok: true, data: result.data as z.output<Schema> };
}

// Amount-to-base-units conversion can reject schema-valid input (more
// fractional digits than the asset supports); that is a client error, not an
// internal one.
export function convertAmountOr400(
  c: Context<Env, string>,
  convert: () => string
): { ok: true; value: bigint } | { ok: false; response: Response } {
  try {
    return { ok: true, value: BigInt(convert()) };
  } catch (error) {
    return {
      ok: false,
      response: c.json(
        {
          error:
            error instanceof Error ? error.message : "Invalid amount",
        },
        400
      ),
    };
  }
}
