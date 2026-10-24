import { calculateBackoff, sleep } from './time.js';
import { logger } from './logger.js';

export interface RetryOptions {
  maxRetries?: number;
  baseMs?: number;
  maxMs?: number;
  factor?: number;
  operationName?: string;
  shouldRetry?: (error: any) => boolean;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseMs = 1000,
    maxMs = 20000,
    factor = 2,
    operationName = 'operation',
    shouldRetry = () => true,
  } = options;

  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (attempt === maxRetries || !shouldRetry(err)) {
        throw err;
      }
      const delay = calculateBackoff(attempt, baseMs, maxMs, factor);
      logger.warn(
        `[${operationName}] Failed (attempt ${attempt + 1}/${maxRetries + 1}): ${
          err.message || String(err)
        }. Retrying in ${delay}ms...`
      );
      await sleep(delay);
    }
  }

  throw lastError;
}
