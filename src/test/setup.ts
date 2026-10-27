import { mock } from "bun:test";

// tronweb's generated protobuf modules extend a global `proto` object that
// the first loaded module creates. Bun can load them in a different order
// than the Workers bundle, so make sure the object exists up front.
(globalThis as { proto?: object }).proto ??= {};

// Durable Object base class stand-in for running DO classes under bun.
mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
