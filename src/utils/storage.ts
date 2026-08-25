/**
 * Shared key/value storage used by the session, token and rate-limit layers.
 *
 * Backed by Redis when REDIS_URL is set, otherwise Vercel KV. The adapter is
 * created lazily so importing this module never throws in environments that
 * only need the stdio server.
 */

export interface StorageAdapter {
  set(key: string, value: unknown, options?: { ex?: number }): Promise<void>;
  get<T>(key: string): Promise<T | null>;
  del(key: string): Promise<void>;
  incrementWithTtl(key: string, ttlSeconds: number): Promise<number>;
}

class VercelKVAdapter implements StorageAdapter {
  private kv: any = null;

  private async client() {
    if (!this.kv) {
      const { kv } = await import("@vercel/kv");
      this.kv = kv;
    }
    return this.kv;
  }

  async set(key: string, value: unknown, options?: { ex?: number }): Promise<void> {
    const kv = await this.client();
    await kv.set(key, value, options);
  }

  async get<T>(key: string): Promise<T | null> {
    const kv = await this.client();
    return ((await kv.get(key)) as T | null) ?? null;
  }

  async del(key: string): Promise<void> {
    const kv = await this.client();
    await kv.del(key);
  }

  async incrementWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const kv = await this.client();
    const count = (await kv.incr(key)) as number;
    if (count === 1) {
      await kv.expire(key, ttlSeconds);
    }
    return count;
  }
}

class RedisAdapter implements StorageAdapter {
  private client: any = null;
  private connecting: Promise<void> | null = null;

  private async connect(): Promise<void> {
    if (this.client?.isOpen) return;

    if (!this.connecting) {
      this.connecting = (async () => {
        const { createClient } = await import("redis");
        const client = createClient({ url: process.env.REDIS_URL });
        client.on("error", (err: unknown) => {
          console.error("Redis error:", err instanceof Error ? err.message : "unknown");
        });
        await client.connect();
        this.client = client;
      })().finally(() => {
        this.connecting = null;
      });
    }

    await this.connecting;
  }

  async set(key: string, value: unknown, options?: { ex?: number }): Promise<void> {
    await this.connect();
    const serialized = JSON.stringify(value);
    if (options?.ex) {
      await this.client.setEx(key, options.ex, serialized);
    } else {
      await this.client.set(key, serialized);
    }
  }

  async get<T>(key: string): Promise<T | null> {
    await this.connect();
    const value = await this.client.get(key);
    return value ? (JSON.parse(value) as T) : null;
  }

  async del(key: string): Promise<void> {
    await this.connect();
    await this.client.del(key);
  }

  async incrementWithTtl(key: string, ttlSeconds: number): Promise<number> {
    await this.connect();
    const count = (await this.client.incr(key)) as number;
    if (count === 1) {
      await this.client.expire(key, ttlSeconds);
    }
    return count;
  }
}

let adapter: StorageAdapter | null = null;

/**
 * Test seam: swap in an in-memory adapter so handlers can be exercised without
 * a live Redis or KV instance. Pass null to restore the configured backend.
 */
export function setStorageAdapter(next: StorageAdapter | null): void {
  adapter = next;
}

export function getStorage(): StorageAdapter {
  if (adapter) return adapter;

  if (process.env.REDIS_URL) {
    adapter = new RedisAdapter();
  } else if (process.env.KV_REST_API_URL) {
    adapter = new VercelKVAdapter();
  } else {
    throw new Error(
      "No storage configuration found. Set either REDIS_URL or KV_REST_API_URL."
    );
  }

  return adapter;
}
