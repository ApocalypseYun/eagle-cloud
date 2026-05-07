/**
 * StorageProvider — pluggable cloud storage backend interface.
 *
 * Re-exports core types for provider implementors.
 * Provides BaseProvider with common retry/backoff logic.
 */

export type { StorageProvider, FileEntry, FileMeta, PartInfo } from '../core/types.js';

// ─── Retry Configuration ──────────────────────────────────────────────────────

export interface RetryOptions {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 300_000,
};

// ─── Base Provider ────────────────────────────────────────────────────────────

export abstract class BaseProvider {
  protected readonly retryOptions: RetryOptions;

  constructor(retryOptions: Partial<RetryOptions> = {}) {
    this.retryOptions = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions };
  }

  /**
   * Execute an operation with exponential backoff retry.
   * Only retries on transient/network errors.
   */
  protected async withRetry<T>(
    operation: () => Promise<T>,
    label: string,
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.retryOptions.maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (!this.isRetryable(lastError) || attempt === this.retryOptions.maxAttempts) {
          break;
        }

        const delay = this.computeBackoff(attempt);
        await this.sleep(delay);
      }
    }

    throw new Error(
      `[${label}] Failed after ${this.retryOptions.maxAttempts} attempts: ${lastError?.message}`,
    );
  }

  /**
   * Determine whether an error is transient and worth retrying.
   * Subclasses may override for provider-specific classification.
   */
  protected isRetryable(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes('timeout') ||
      message.includes('econnreset') ||
      message.includes('econnrefused') ||
      message.includes('socket hang up') ||
      message.includes('network') ||
      message.includes('429') ||
      message.includes('503')
    );
  }

  /**
   * Exponential backoff with jitter (0–50%), capped at maxDelayMs.
   */
  protected computeBackoff(attempt: number): number {
    const exponential = this.retryOptions.baseDelayMs * Math.pow(2, attempt - 1);
    const capped = Math.min(exponential, this.retryOptions.maxDelayMs);
    const jitter = capped * Math.random() * 0.5;
    return capped + jitter;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
