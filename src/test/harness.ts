import * as bip39 from "bip39";

export function createMemoryStorage() {
  const map = new Map<string, unknown>();

  return {
    map,
    async get<T>(key: string): Promise<T | undefined> {
      const value = map.get(key);
      return value === undefined ? undefined : (structuredClone(value) as T);
    },
    async put(key: string, value: unknown): Promise<void> {
      map.set(key, structuredClone(value));
    },
    async delete(key: string): Promise<boolean> {
      return map.delete(key);
    },
  };
}

/** Runs callbacks one at a time, like DurableObjectState.blockConcurrencyWhile. */
function createConcurrencyBlocker() {
  let queue: Promise<unknown> = Promise.resolve();

  return <T>(callback: () => Promise<T>): Promise<T> => {
    const run = queue.then(callback);
    queue = run.catch(() => undefined);
    return run;
  };
}

export async function createSigner() {
  const { Signer } = await import("../services/Signer");
  const storage = createMemoryStorage();
  const signer = new Signer(
    {
      storage,
      blockConcurrencyWhile: createConcurrencyBlocker(),
    } as unknown as DurableObjectState,
    {
      mnemonic: bip39.generateMnemonic(),
      TRONGRID_BASE_URL: "http://127.0.0.1:1",
    }
  );

  // Signing needs a real raw_data_hex; the tests only care about bookkeeping.
  // The yield lets concurrent requests interleave if nothing serializes them.
  (
    signer as unknown as {
      tronWeb: { trx: { sign: (tx: Record<string, unknown>) => Promise<unknown> } };
    }
  ).tronWeb.trx.sign = async (tx) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return { ...tx, signature: ["00"] };
  };

  return { signer, storage };
}

export function createNamespace(handler: (req: Request) => Response | Promise<Response>) {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: (url: string, init?: RequestInit) => handler(new Request(url, init)),
    }),
  };
}
