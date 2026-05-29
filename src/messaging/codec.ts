/**
 * Payload (de)serialization for `forge/messaging`.
 *
 * A {@link Codec} turns a domain payload into the bytes a
 * {@link Transport} carries, and back. The default — {@link jsonCodec}
 * — uses `JSON` + UTF-8, which covers the common case. Bring your own
 * for protobuf, MessagePack, or opaque blobs.
 *
 * @module
 */

import { SerializationError } from "./errors";

/** Turns a payload into transport bytes and back. */
export interface Codec {
  /** MIME type advertised for encoded bodies, e.g. `"application/json"`. */
  readonly contentType: string;
  /** Encode a payload to bytes. Throws {@link SerializationError} on failure. */
  encode(payload: unknown): Uint8Array;
  /** Decode bytes back to a payload. Throws {@link SerializationError} on failure. */
  decode(body: Uint8Array): unknown;
}

/**
 * The default JSON codec: `JSON.stringify` + UTF-8 encode on the way
 * out, UTF-8 decode + `JSON.parse` on the way in. Encoding `undefined`
 * (which `JSON.stringify` drops) is rejected so a payload never
 * silently becomes `undefined` on the far side.
 */
export function jsonCodec(): Codec {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });

  return {
    contentType: "application/json",
    encode(payload: unknown): Uint8Array {
      let json: string | undefined;
      try {
        json = JSON.stringify(payload);
      } catch (cause) {
        throw new SerializationError("Failed to JSON-encode message payload", {
          cause,
        });
      }
      if (json === undefined) {
        throw new SerializationError(
          "Message payload encoded to `undefined` (JSON cannot represent it)",
        );
      }
      return encoder.encode(json);
    },
    decode(body: Uint8Array): unknown {
      let text: string;
      try {
        text = decoder.decode(body);
      } catch (cause) {
        throw new SerializationError("Message body is not valid UTF-8", {
          cause,
        });
      }
      try {
        return JSON.parse(text);
      } catch (cause) {
        throw new SerializationError("Failed to JSON-decode message body", {
          cause,
        });
      }
    },
  };
}
