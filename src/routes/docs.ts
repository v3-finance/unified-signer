import { Scalar } from "@scalar/hono-api-reference";
import { createMarkdownFromOpenApi } from "@scalar/openapi-to-markdown";
import type { Hono } from "hono";
import type { Env } from "../env";
import { createOpenApiDocument } from "../docs/openapi";
import { parseEvmNetworks } from "../lib/networks";

export function registerDocsRoutes(app: Hono<Env>) {
  app.get("/doc", (c) => {
    return c.json(
      createOpenApiDocument(c.env.baseUrl, parseEvmNetworks(c.env.EVM_NETWORKS))
    );
  });

  app.get(
    "/",
    Scalar({
      url: "/doc",
      theme: "default",
      layout: "modern",
      pageTitle: "Unified Signer API",
      defaultHttpClient: {
        targetKey: "http",
        clientKey: "fetch",
      },
      authentication: {
        preferredSecurityScheme: null,
      },
    })
  );

  app.get("/llms.txt", async (c) => {
    const markdown = await createMarkdownFromOpenApi(
      createOpenApiDocument(c.env.baseUrl, parseEvmNetworks(c.env.EVM_NETWORKS))
    );
    return c.text(markdown);
  });
}
