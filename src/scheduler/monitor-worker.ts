import { MonitorEngine } from '../modules/monitoring/monitor-engine.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/time.js';

export class MonitorWorker {
  private engine: MonitorEngine;
  private intervalSeconds: number;
  private concurrency: number;
  private delayMs: number;
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    engine: MonitorEngine,
    intervalSeconds = 10,
    concurrency = 3,
    delayMs = 1000
  ) {
    this.engine = engine;
    this.intervalSeconds = Math.max(2, intervalSeconds);
    this.concurrency = concurrency;
    this.delayMs = delayMs;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    logger.info(
      `Starting Monitor Worker: polling every ${this.intervalSeconds}s, concurrency: ${this.concurrency}, delay: ${this.delayMs}ms`
    );

    // Run first cycle immediately
    this.tick();

    // Schedule next cycles
    const intervalMs = this.intervalSeconds * 1000;
    this.timer = setInterval(() => {
      this.tick();
    }, intervalMs);
  }

  private async tick() {
    try {
      await this.engine.runCycle({
        concurrency: this.concurrency,
        delayMs: this.delayMs,
      });
    } catch (err: any) {
      logger.error('Unhandled error during monitor cycle tick:', err);
    }
  }

  async stop() {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    logger.info('Waiting for ongoing monitor operations to complete...');
    // Wait until engine finishes current job
    while (this.engine.isBusy) {
      await sleep(500);
    }

    logger.info('Monitor Worker stopped safely.');
  }
}
