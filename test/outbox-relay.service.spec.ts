import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { OutboxRelayService } from '../src/outbox/outbox-relay.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { Publisher } from '../src/kafka/publisher';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  created_at: Date;
}

function envelope(aggregateId: string, type: string): OutboxRow {
  return {
    id: randomUUID(),
    aggregate_id: aggregateId,
    event_type: type,
    payload: {
      eventId: randomUUID(),
      eventType: type,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      payload: { hello: 'world' },
    },
    created_at: new Date(),
  };
}

// Minimal Prisma stand-in: a mutable set of rows behind $transaction, and a
// $queryRaw that pops the first batch. UpdateMany removes them from the set,
// so a second drain sees an empty queue.
function makePrisma(initial: OutboxRow[]) {
  let rows = [...initial];
  const queryRaw = jest.fn(async () => rows.slice());
  const updateMany = jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
    const ids = new Set(where.id.in);
    rows = rows.filter((r) => !ids.has(r.id));
    return { count: ids.size };
  });
  const transaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    return fn({ $queryRaw: queryRaw, outbox: { updateMany } });
  });
  return {
    prisma: { $transaction: transaction } as unknown as PrismaService,
    queryRaw,
    updateMany,
    transaction,
    remaining: () => rows.length,
  };
}

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    OUTBOX_RELAY_ENABLED: true,
    OUTBOX_RELAY_POLL_INTERVAL_MS: 250,
    OUTBOX_RELAY_BATCH_SIZE: 32,
    OUTBOX_RELAY_ERROR_BACKOFF_MS: 5000,
    ...overrides,
  };
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

function makePublisher(): { publisher: Publisher; publish: jest.Mock } {
  const publish = jest.fn(async () => undefined);
  return { publisher: { publish }, publish };
}

describe('OutboxRelayService.drainOnce', () => {
  it('publishes every unsent row and marks them sent', async () => {
    const rows = [
      envelope('user-1', 'user.registered'),
      envelope('user-2', 'user.registered'),
    ];
    const { prisma, updateMany, remaining } = makePrisma(rows);
    const { publisher, publish } = makePublisher();
    const relay = new OutboxRelayService(makeConfig(), prisma, publisher);

    const processed = await relay.drainOnce();

    expect(processed).toBe(2);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[0][0]).toMatchObject({
      topic: 'user.registered',
      key: 'user-1',
    });
    expect(JSON.parse(publish.mock.calls[0][0].value)).toMatchObject({
      eventType: 'user.registered',
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { sentAt: expect.any(Date) },
    });
    expect(remaining()).toBe(0);
  });

  it('returns 0 and never touches the publisher when the queue is empty', async () => {
    const { prisma, updateMany } = makePrisma([]);
    const { publisher, publish } = makePublisher();
    const relay = new OutboxRelayService(makeConfig(), prisma, publisher);

    const processed = await relay.drainOnce();

    expect(processed).toBe(0);
    expect(publish).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('propagates publish failure so the tx rolls back and rows stay unsent', async () => {
    const rows = [envelope('user-9', 'user.registered')];
    const { prisma, updateMany, remaining } = makePrisma(rows);
    const publish = jest.fn(async () => {
      throw new Error('kafka down');
    });
    const relay = new OutboxRelayService(
      makeConfig(),
      prisma,
      { publish } as unknown as Publisher,
    );

    // The transaction stand-in returns the callback's promise directly, so the
    // thrown error bubbles up here as it would from a real Prisma rollback.
    await expect(relay.drainOnce()).rejects.toThrow('kafka down');
    expect(updateMany).not.toHaveBeenCalled();
    expect(remaining()).toBe(1);
  });
});

describe('OutboxRelayService lifecycle', () => {
  it('does not schedule ticks when disabled', () => {
    const { prisma, transaction } = makePrisma([]);
    const { publisher } = makePublisher();
    const relay = new OutboxRelayService(
      makeConfig({ OUTBOX_RELAY_ENABLED: false }),
      prisma,
      publisher,
    );
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    relay.onApplicationBootstrap();

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it('stops scheduling further ticks after shutdown', async () => {
    const { prisma } = makePrisma([]);
    const { publisher } = makePublisher();
    const relay = new OutboxRelayService(makeConfig(), prisma, publisher);
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    // Bootstrap schedules an immediate first tick. We immediately shut down —
    // the tick either has not fired or fires and reschedules against a stopped
    // relay (which is a no-op). Either way no new timers should live past the
    // shutdown call.
    relay.onApplicationBootstrap();
    await relay.onApplicationShutdown();
    setTimeoutSpy.mockClear();

    // Nothing should schedule after shutdown, even if we manually reach in.
    // (We cannot invoke the private tick, but a subsequent bootstrap should
    // also be inert because `stopped` is sticky.)
    relay.onApplicationBootstrap();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });
});
