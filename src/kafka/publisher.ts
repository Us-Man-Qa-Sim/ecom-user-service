// Publisher: what the outbox relay actually needs from Kafka. Keeping it a
// narrow interface (rather than passing a Producer around) means tests inject a
// fake with a single `publish` method, and swapping producer libraries later is
// a leaf change. The relay also lives inside its own module boundary — copying
// the relay to order-service means copying this interface too.

export interface OutboundMessage {
  topic: string;
  // Kafka message key = partition key. For order-related topics this MUST be
  // `orderId` so all events for one order land on the same partition and are
  // consumed in order (§2 architecture). For `user.registered` we use the user
  // id — there is no ordering constraint but keying by aggregate id keeps hot
  // users on a stable partition which helps notification-service caching.
  key: string;
  // The serialised event envelope. Kept as a string so this layer never has to
  // know about Envelope shape; the outbox stores the envelope as JSON already.
  value: string;
  headers?: Record<string, string>;
}

export interface Publisher {
  publish(message: OutboundMessage): Promise<void>;
}

// Injection token used by OutboxRelayService so the concrete Kafka producer can
// be swapped for a fake in tests without dragging in @nestjs/testing.
export const PUBLISHER = Symbol('Publisher');
