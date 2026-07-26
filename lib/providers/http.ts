import "server-only";

import type { ProviderConfig } from "./config.ts";

export interface HttpJsonClientOptions {
  endpointUrl: string;
  timeoutMs: number;
  maxResponseBytes: number;
  token: string | null;
}

export class HttpProviderError extends Error {
  readonly kind: "timeout" | "http" | "response-too-large" | "invalid-json" | "network";

  constructor(
    kind: HttpProviderError["kind"],
    message: string,
  ) {
    super(message);
    this.name = "HttpProviderError";
    this.kind = kind;
  }
}

export type FetchImplementation = typeof fetch;

export class HttpJsonClient {
  constructor(
    private readonly options: HttpJsonClientOptions,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  async postJson<T>(payload: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
      if (this.options.token) {
        headers.set("authorization", `Bearer ${this.options.token}`);
      }
      let response: Response;
      try {
        response = await this.fetchImplementation(this.options.endpointUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
          redirect: "error",
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new HttpProviderError("timeout", "Configured provider request timed out.");
        }
        throw new HttpProviderError(
          "network",
          error instanceof Error ? "Configured provider request failed." : "Configured provider request failed.",
        );
      }
      if (!response.ok) {
        throw new HttpProviderError("http", `Configured provider returned HTTP ${response.status}.`);
      }
      if (response.url && response.url !== this.options.endpointUrl) {
        throw new HttpProviderError(
          "http",
          "Configured provider response URL did not match the fixed endpoint.",
        );
      }
      const text = await readBoundedText(response, this.options.maxResponseBytes);
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new HttpProviderError("invalid-json", "Configured provider returned invalid JSON.");
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createHttpJsonClient(
  endpointUrl: string,
  config: Pick<ProviderConfig, "timeoutMs" | "maxResponseBytes">,
  token: string | null,
  fetchImplementation?: FetchImplementation,
): HttpJsonClient {
  return new HttpJsonClient(
    {
      endpointUrl,
      timeoutMs: config.timeoutMs,
      maxResponseBytes: config.maxResponseBytes,
      token,
    },
    fetchImplementation,
  );
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new HttpProviderError(
      "response-too-large",
      "Configured provider response exceeds the response-size limit.",
    );
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new HttpProviderError(
          "response-too-large",
          "Configured provider response exceeds the response-size limit.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
