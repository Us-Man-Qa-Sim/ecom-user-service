import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { Env } from '../config/env.validation';
import { OutboundMessage, Publisher } from './publisher';

// Thin wrapper over @confluentinc/kafka-javascript's KafkaJS-compatible API.
// Two things worth calling out:
//   1. `idempotent: true` — the broker deduplicates retries so a single
//      producer.send() cannot land the same message twice on the wire even if
//      it retries under the hood. Combined with SKIP LOCKED at the outbox side
//      this is what gives us "publish exactly-once from the relay's point of
//      view" (consumers still need inbox dedupe for delivery duplicates).
//   2. `acks: -1` (all) — waits for the full ISR to ack, otherwise idempotence
//      is meaningless: a leader-only ack can be lost on failover.
// KFK-1 will formalise the wrapper further (consumer side, envelope validation,
// header propagation); this is the producer half needed by USR-8.
@Injectable()
export class KafkaProducerService implements OnModuleInit, OnApplicationShutdown, Publisher {
  private readonly logger = new Logger(KafkaProducerService.name);
  private readonly kafka: KafkaJS.Kafka;
  private producer?: KafkaJS.Producer;
  private connected = false;

  constructor(config: ConfigService<Env, true>) {
    const brokers = config.get('KAFKA_BROKERS', { infer: true }).split(',');
    const clientId = config.get('KAFKA_CLIENT_ID', { infer: true });
    this.kafka = new KafkaJS.Kafka({ kafkaJS: { brokers, clientId } });
  }

  async onModuleInit(): Promise<void> {
    this.producer = this.kafka.producer({
      kafkaJS: {
        idempotent: true,
        acks: -1,
        // 30 s: long enough to survive short broker blips, short enough that a
        // real outage surfaces to the caller instead of hanging the relay tick.
        timeout: 30_000,
      },
    });
    await this.producer.connect();
    this.connected = true;
    this.logger.log('Kafka producer connected');
  }

  // onApplicationShutdown, not onModuleDestroy: the outbox relay drains its
  // last tick in onModuleDestroy and needs the producer until then.
  async onApplicationShutdown(): Promise<void> {
    if (this.producer && this.connected) {
      try {
        await this.producer.flush({ timeout: 5_000 });
      } catch (err) {
        this.logger.warn({ err }, 'Kafka producer flush failed on shutdown');
      }
      await this.producer.disconnect();
      this.connected = false;
      this.logger.log('Kafka producer disconnected');
    }
  }

  async publish(message: OutboundMessage): Promise<void> {
    if (!this.producer || !this.connected) {
      throw new Error('Kafka producer not connected');
    }
    await this.producer.send({
      topic: message.topic,
      messages: [
        {
          key: message.key,
          value: message.value,
          headers: message.headers,
        },
      ],
    });
  }
}
