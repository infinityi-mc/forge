import { describe, expect, test } from "bun:test";
import * as root from "../../src";
import * as messaging from "../../src/messaging";

describe("messaging exports", () => {
  test("messaging symbols stay scoped to forge/messaging rather than the package root", () => {
    expect(messaging.createMessageBus).toBeFunction();
    expect(messaging.createConsumer).toBeFunction();
    expect(messaging.jsonCodec).toBeFunction();
    expect("createMessageBus" in root).toBe(false);
  });

  test("error taxonomy is exported", () => {
    expect(new messaging.TransportError("x")).toBeInstanceOf(messaging.MessagingError);
    expect(new messaging.SerializationError("x")).toBeInstanceOf(
      messaging.MessagingError,
    );
    expect(new messaging.HandlerError("x")).toBeInstanceOf(messaging.MessagingError);
  });
});
