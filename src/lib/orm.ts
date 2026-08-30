import type { Context } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { DOFailureError } from "./errors";
import * as schemas from "./schemas/do";
import {
  type EvmCalculateDoRequest,
  type EvmCalculateResponse,
  EvmCalculateDoRequestSchema,
  evmCalculateResponseSchema,
} from "./schemas/evm";
import {
  type CalculateGasRequest,
  type CalculateGasResponse,
  calculateSchema,
  calculateSchemaResponse,
} from "./schemas/tron";

export const DO_ROUTES = {
  TX_BUILDER: {
    "/tronTxBuild": {
      method: "POST" as const,
      body: schemas.TronTxBuildRequestSchema,
      response: schemas.TronTxBuildResponseSchema,
    },
    "/evmTxBuild": {
      method: "POST" as const,
      body: schemas.EvmTxBuildRequestSchema,
      response: schemas.EvmTxBuildResponseSchema,
    },
  },
  SIGNER: {
    "/sign": {
      method: "POST" as const,
      body: schemas.TronTxSignRequestSchema,
      response: schemas.TronTxSignResponseSchema,
    },
    "/evmSign": {
      method: "POST" as const,
      body: schemas.EvmTxSignRequestSchema,
      response: schemas.EvmTxSignResponseSchema,
    },
  },
  GAS_CALCULATOR: {
    "/calculate": {
      method: "POST" as const,
      body: calculateSchema,
      response: calculateSchemaResponse,
    },
    "/evmCalculate": {
      method: "POST" as const,
      body: EvmCalculateDoRequestSchema,
      response: evmCalculateResponseSchema,
    },
  },
  REGISTRY: {
    "/getAddressByIndex": {
      method: "GET" as const,
      query: schemas.RegistryAddressQuerySchema,
      response: schemas.AddressResponseSchema,
    },
    "/getBalance": {
      method: "GET" as const,
      query: schemas.RegistryBalanceQuerySchema,
      response: schemas.WalletBalanceResponse,
    },
  },
} as const;

type DONamespace = keyof typeof DO_ROUTES;
type DORoute<N extends DONamespace> = keyof (typeof DO_ROUTES)[N] & string;

type InferBodyInput<N extends DONamespace, R extends DORoute<N>> =
  (typeof DO_ROUTES)[N][R] extends { body: infer S extends z.ZodTypeAny }
    ? z.input<S>
    : never;

type InferQueryInput<N extends DONamespace, R extends DORoute<N>> =
  (typeof DO_ROUTES)[N][R] extends { query: infer S extends z.ZodTypeAny }
    ? z.input<S>
    : never;

type InferResponse<N extends DONamespace, R extends DORoute<N>> =
  (typeof DO_ROUTES)[N][R] extends { response: infer S extends z.ZodTypeAny }
    ? z.output<S>
    : never;

async function parseResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type");

  if (contentType?.includes("application/json")) {
    return response.json();
  }

  return response.text();
}

async function callDO<N extends DONamespace, R extends DORoute<N>>(
  c: Context<Env>,
  namespace: N,
  instanceName: string,
  route: R,
  options?: {
    body?: InferBodyInput<N, R>;
    query?: InferQueryInput<N, R>;
    validateRequest?: boolean;
    validateResponse?: boolean;
  }
): Promise<InferResponse<N, R>> {
  const {
    body,
    query,
    validateRequest = false,
    validateResponse = false,
  } = options || {};
  const routeSchema = DO_ROUTES[namespace][route] as {
    method: "GET" | "POST";
    body?: z.ZodTypeAny;
    query?: z.ZodTypeAny;
    response?: z.ZodTypeAny;
  };

  if (validateRequest) {
    if (routeSchema.body && body !== undefined) {
      routeSchema.body.parse(body);
    }

    if (routeSchema.query && query !== undefined) {
      routeSchema.query.parse(query);
    }
  }

  const doNamespace = c.env[namespace];
  const id = doNamespace.idFromName(instanceName);
  const stub = doNamespace.get(id);

  let url = `https://do${route}`;
  if (query) {
    const searchParams = new URLSearchParams();

    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        searchParams.set(key, String(value));
      }
    }

    if (searchParams.size > 0) {
      url += `?${searchParams.toString()}`;
    }
  }

  const response = await stub.fetch(url, {
    method: routeSchema.method,
    headers: { "content-type": "application/json" },
    body:
      body !== undefined && routeSchema.method !== "GET"
        ? JSON.stringify(body)
        : undefined,
  });

  const responseData = await parseResponse(response);

  if (!response.ok) {
    // 4xx payloads are surfaced to API clients by app.onError; 5xx stay
    // internal.
    throw new DOFailureError(
      `${namespace}${route}`,
      response.status,
      responseData
    );
  }

  if (validateResponse && routeSchema.response) {
    return routeSchema.response.parse(responseData) as InferResponse<N, R>;
  }

  return responseData as InferResponse<N, R>;
}

abstract class BaseDOClient<N extends DONamespace> {
  constructor(
    protected readonly c: Context<Env>,
    protected readonly namespace: N,
    protected readonly instanceName: string,
    protected readonly validateByDefault = false
  ) {}

  protected async call<R extends DORoute<N>>(
    route: R,
    options?: {
      body?: InferBodyInput<N, R>;
      query?: InferQueryInput<N, R>;
      validate?: boolean;
    }
  ): Promise<InferResponse<N, R>> {
    return callDO(this.c, this.namespace, this.instanceName, route, {
      body: options?.body,
      query: options?.query,
      validateRequest: options?.validate ?? this.validateByDefault,
      validateResponse: options?.validate ?? this.validateByDefault,
    });
  }
}

export class TxBuilderClient extends BaseDOClient<"TX_BUILDER"> {
  constructor(c: Context<Env>, instanceName: string, validate = false) {
    super(c, "TX_BUILDER", instanceName, validate);
  }

  async build(
    data: z.input<typeof schemas.TronTxBuildRequestSchema>
  ): Promise<schemas.TronTxBuildResponse> {
    return this.call("/tronTxBuild", { body: data });
  }

  async buildEvm(
    data: z.input<typeof schemas.EvmTxBuildRequestSchema>
  ): Promise<schemas.EvmTxBuildResponse> {
    return this.call("/evmTxBuild", { body: data });
  }
}

export class GasCalculatorClient extends BaseDOClient<"GAS_CALCULATOR"> {
  constructor(c: Context<Env>, instanceName: string, validate = false) {
    super(c, "GAS_CALCULATOR", instanceName, validate);
  }

  async calculate(data: CalculateGasRequest): Promise<CalculateGasResponse> {
    return this.call("/calculate", { body: data });
  }

  async calculateEvm(
    data: z.input<typeof EvmCalculateDoRequestSchema>
  ): Promise<EvmCalculateResponse> {
    return this.call("/evmCalculate", { body: data });
  }
}

export class SignerClient extends BaseDOClient<"SIGNER"> {
  constructor(c: Context<Env>, instanceName: string, validate = false) {
    super(c, "SIGNER", instanceName, validate);
  }

  async sign(
    data: schemas.TronTxSignRequest
  ): Promise<schemas.TronTxSignResponse> {
    return this.call("/sign", { body: data });
  }

  async signEvm(
    data: z.input<typeof schemas.EvmTxSignRequestSchema>
  ): Promise<schemas.EvmTxSignResponse> {
    return this.call("/evmSign", { body: data });
  }
}

export class RegistryClient extends BaseDOClient<"REGISTRY"> {
  constructor(c: Context<Env>, instanceName: string, validate = false) {
    super(c, "REGISTRY", instanceName, validate);
  }

  async getAddressByIndex(
    query: z.input<typeof schemas.RegistryAddressQuerySchema>
  ): Promise<z.infer<typeof schemas.AddressResponseSchema>> {
    return this.call("/getAddressByIndex", { query });
  }

  async getBalance(
    query: z.input<typeof schemas.RegistryBalanceQuerySchema>
  ): Promise<z.infer<typeof schemas.WalletBalanceResponse>> {
    return this.call("/getBalance", { query });
  }
}

export function createDOClient(
  c: Context<Env>,
  network: string,
  validateByDefault = false
) {
  return {
    txBuilder: () => new TxBuilderClient(c, network, validateByDefault),
    calculator: () => new GasCalculatorClient(c, network, validateByDefault),
    signer: () => new SignerClient(c, network, validateByDefault),
    registry: () => new RegistryClient(c, network, validateByDefault),
  };
}

export const DO = createDOClient;
