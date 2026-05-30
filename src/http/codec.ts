/**
 * Body (de)serialization seam for `forge/http`.
 *
 * The default {@link jsonCodec} covers the common case. A custom
 * {@link Codec} lets callers speak a different wire format (msgpack,
 * form-encoded, …) without touching the request pipeline. The codec is
 * responsible for both encoding outbound bodies and decoding inbound
 * ones; problem-detail (`application/problem+json`) parsing is handled
 * by the client itself, independent of the codec.
 *
 * @module
 */

import type { BodyInit } from "./types";

/** Encodes outbound bodies and decodes inbound responses. */
export interface Codec {
  /** `Content-Type` set on outbound requests that carry an encoded body. */
  readonly contentType: string;
  /**
   * Encode a value into a `BodyInit`. Return `undefined` to send no
   * body (e.g. for `null`/`undefined`). Raw `BodyInit` values
   * (strings, `Blob`, `ArrayBuffer`, `FormData`, …) are passed through
   * untouched by the client and never reach `encode`.
   */
  encode(value: unknown): BodyInit | undefined;
  /**
   * Decode a response body into `T`. Implementations should tolerate an
   * empty body (e.g. `204 No Content`) by resolving `undefined`.
   */
  decode<T>(response: Response): Promise<T>;
}

/** Default JSON codec: `application/json`, `JSON.stringify`/`res.json()`. */
export const jsonCodec: Codec = {
  contentType: "application/json",
  encode(value) {
    if (value === undefined || value === null) return undefined;
    return JSON.stringify(value);
  },
  async decode<T>(response: Response): Promise<T> {
    // 204/205 and empty bodies decode to `undefined` rather than
    // throwing on `JSON.parse("")`.
    if (response.status === 204 || response.status === 205) {
      return undefined as T;
    }
    const text = await response.text();
    if (text.length === 0) return undefined as T;
    return JSON.parse(text) as T;
  },
};
