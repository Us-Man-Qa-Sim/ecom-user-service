import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import { PUBLISHER, Publisher } from '../kafka/publisher';

// Row shape returned by the raw SELECT — column names come back exactly as
// spelled in schema.prisma (`@map`), not their Prisma model casing.
interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Prisma.JsonValue;
  created_at: Date;
}

// USR-8: outbox relay.
//
// Design in one paragraph. A single scheduled loop wakes up, opens a Prisma
// transaction, does `SELECT ... WHERE sent_at IS NULL ORDER BY created_at
// LIMIT $batch FOR UPDATE SKIP LOCKED`, publishes each envelope through the
// Publisher, then `UPDATE outbox SET sent_at = NOW() WHERE id IN (...)`, and
// commits. Row locks are held across the publish; that is intentional. SKIP
// LOCKED means other pods of the same relay will not touch these rows during
// the publish, so we never double-publish from concurrent relays. If publish
// fails the tx rolls back — the row stays `sent_at IS NULL` and the next tick
// picks it up (at-least-once; consumers dedupe on eventId via processed_events).
//
// Why not "claim first, publish outside the tx" (the classic two-phase relay)?
// Because with a claim column you need a stuck-claim reaper and a way to tell a
// crashed pod from a slow publish. SKIP LOCKED is that mechanism for free —
// pod dies, Postgres releases the locks, the next tick picks the rows up.
//
// Reusable for order-service (per plan): the ONLY user-service-specific piece
// is the table name `outbox`. Copy this file plus publisher.ts / kafka.module
// into order-service unchanged and you get the same relay.
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly errorBackoffMs: number;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    @Inject(PUBLISHER) private readonly publisher: Publisher,
  ) {
    this.enabled = config.get('OUTBOX_RELAY_ENABLED', { infer: true });
    this.pollIntervalMs = config.get('OUTBOX_RELAY_POLL_INTERVAL_MS', { infer: true });
    this.batchSize = config.get('OUTBOX_RELAY_BATCH_SIZE', { infer: true });
    this.errorBackoffMs = config.get('OUTBOX_RELAY_ERROR_BACKOFF_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Outbox relay disabled (OUTBOX_RELAY_ENABLED=false)');
      return;
    }
    this.logger.log(
      `Outbox relay started (batch=${this.batchSize}, poll=${this.pollIntervalMs}ms)`,
    );
    this.scheduleNextTick(0);
  }

  // Stop in onModuleDestroy, not onApplicationShutdown: Nest runs every
  // onModuleDestroy hook before any onApplicationShutdown hook, and Prisma /
  // Kafka close their connections in onApplicationShutdown. Draining here
  // guarantees the in-flight tick still has both clients available.
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Wait for the in-flight tick to finish so its publish + mark-sent commit.
    const start = Date.now();
    while (this.running && Date.now() - start < 10_000) {
      await sleep(50);
    }
    if (this.running) {
      this.logger.warn('Shutdown timed out with a relay tick still in flight');
    }
  }

  // Exposed for tests: run a single drain pass synchronously and return how
  // many rows were processed. Never invoked by the scheduler.
  async drainOnce(): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<OutboxRow[]>`
        SELECT id, aggregate_id, event_type, payload, created_at
        FROM outbox
        WHERE sent_at IS NULL
        ORDER BY created_at
        LIMIT ${this.batchSize}
        FOR UPDATE SKIP LOCKED
      `;
      if (rows.length === 0) return 0;

      for (const row of rows) {
        const envelope = row.payload as Record<string, unknown>;
        const correlationId =
          typeof envelope.correlationId === 'string' ? envelope.correlationId : undefined;

        await this.publisher.publish({
          topic: row.event_type,
          key: row.aggregate_id,
          value: JSON.stringify(row.payload),
          headers: correlationId ? { 'x-correlation-id': correlationId } : undefined,
        });
      }

      await tx.outbox.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { sentAt: new Date() },
      });

      return rows.length;
    });
  }

  private scheduleNextTick(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    this.running = true;
    try {
      const processed = await this.drainOnce();
      // Fast-follow when the queue is busy (a full batch means there is
      // probably more to drain), throttle to poll interval when it is quiet.
      const nextDelay = processed === this.batchSize ? 0 : this.pollIntervalMs;
      this.scheduleNextTick(nextDelay);
    } catch (err) {
      // Do not spin: back off before the next attempt so a persistent Postgres
      // or Kafka outage does not fill the log at line rate.
      this.logger.error({ err }, 'Outbox relay tick failed');
      this.scheduleNextTick(this.errorBackoffMs);
    } finally {
      this.running = false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
