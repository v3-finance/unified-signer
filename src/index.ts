import { Hono } from "hono";
import type { Env } from "./env";
import { handleAppError } from "./lib/errors";
import { registerDocsRoutes } from "./routes/docs";
import { registerLegacyRoutes } from "./routes/legacy";
import { registerTransactionRoutes } from "./routes/transaction";
import { registerWalletRoutes } from "./routes/wallet";
import { GasCalculator } from "./services/GasCalculator";
import { Registry } from "./services/Registry";
import { Signer } from "./services/Signer";
import { TxBuilder } from "./services/TxBuilder";

const app = new Hono<Env>();

registerDocsRoutes(app);
// Legacy cloud-tron-wallet API: exact paths must win over the global
// wildcard routes, so these register first.
registerLegacyRoutes(app);
registerWalletRoutes(app);
registerTransactionRoutes(app);

app.onError(handleAppError);

export default app;
export { GasCalculator, Registry, Signer, TxBuilder };
