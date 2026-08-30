import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "./env";
import { DOFailureError } from "./lib/errors";
import { registerDocsRoutes } from "./routes/docs";
import { registerTransactionRoutes } from "./routes/transaction";
import { registerWalletRoutes } from "./routes/wallet";
import { GasCalculator } from "./services/GasCalculator";
import { Registry } from "./services/Registry";
import { Signer } from "./services/Signer";
import { TxBuilder } from "./services/TxBuilder";

const app = new Hono<Env>();

registerDocsRoutes(app);
registerWalletRoutes(app);
registerTransactionRoutes(app);

app.onError((error, c) => {
  console.error(error);

  // A Durable Object rejected the request with a handled 4xx: pass its
  // payload (validation details, build/sign failures) through to the client.
  if (
    error instanceof DOFailureError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.payload &&
    typeof error.payload === "object"
  ) {
    return c.json(error.payload, error.status as ContentfulStatusCode);
  }

  return c.json({ error: "Internal Server Error" }, 500);
});

export default app;
export { GasCalculator, Registry, Signer, TxBuilder };
