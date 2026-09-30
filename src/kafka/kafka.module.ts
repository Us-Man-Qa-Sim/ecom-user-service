import { Global, Module } from '@nestjs/common';
import { KafkaProducerService } from './kafka-producer.service';
import { PUBLISHER } from './publisher';

// Global because the outbox relay lives in another module and there is only
// ever one Kafka producer per service (KFK-1 will preserve this invariant).
@Global()
@Module({
  providers: [
    KafkaProducerService,
    // Bind the abstract Publisher token to the concrete producer so consumers
    // (the relay, future services) depend on Publisher, not KafkaProducerService.
    { provide: PUBLISHER, useExisting: KafkaProducerService },
  ],
  exports: [KafkaProducerService, PUBLISHER],
})
export class KafkaModule {}
