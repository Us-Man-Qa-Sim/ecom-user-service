import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  EventEnvelopeSchema,
  TOPICS,
  UserRegisteredPayloadSchema,
} from '@us-man-qa-sim/ecom-contracts/events';
import { CorrelationService } from '../src/correlation/correlation.service';
import { OutboxService } from '../src/outbox/outbox.service';

interface OutboxRow {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

function makeTx() {
  const create = jest.fn<Promise<void>, [{ data: OutboxRow }]>();
  return {
    tx: { outbox: { create } } as unknown as Prisma.TransactionClient,
    create,
  };
}

describe('OutboxService.enqueue', () => {
  const service = new OutboxService(new CorrelationService());

  it('wraps the payload in a valid EventEnvelope', async () => {
    const { tx, create } = makeTx();
    const userId = randomUUID();

    await service.enqueue(tx, {
      aggregateType: 'User',
      aggregateId: userId,
      topic: TOPICS.USER_REGISTERED,
      payload: {
        userId,
        email: 'a@b.com',
        firstName: 'A',
        lastName: 'B',
      },
    });

    const row = create.mock.calls[0][0].data;
    expect(row.eventType).toBe('user.registered');
    expect(row.aggregateType).toBe('User');

    const parsedEnvelope = EventEnvelopeSchema.parse(row.payload);
    expect(parsedEnvelope.eventType).toBe('user.registered');
    expect(parsedEnvelope.version).toBe(1);
    expect(() => UserRegisteredPayloadSchema.parse(parsedEnvelope.payload)).not.toThrow();
  });

  it('rejects a payload that does not match the topic schema', async () => {
    const { tx } = makeTx();

    await expect(
      service.enqueue(tx, {
        aggregateType: 'User',
        aggregateId: randomUUID(),
        topic: TOPICS.USER_REGISTERED,
        // @ts-expect-error — intentionally malformed to prove the guard fires
        payload: { userId: 'not-a-uuid' },
      }),
    ).rejects.toThrow();
  });
});
