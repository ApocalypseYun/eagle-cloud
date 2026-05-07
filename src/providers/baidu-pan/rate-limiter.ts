// ── RateLimiter ────────────────────────────────────────────────────────────
// Token bucket for burst + daily counter for quota management.

export interface RateLimiterConfig {
  readonly burstPerSecond: number // max requests per second (burst)
  readonly dailySoftLimit: number // soft limit per day
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  burstPerSecond: 8,
  dailySoftLimit: 900,
}

export class RateLimiter {
  private readonly config: RateLimiterConfig
  private tokens: number
  private lastRefillTime: number
  private dailyCount: number
  private dailyResetTime: number

  constructor(config: RateLimiterConfig = DEFAULT_CONFIG) {
    this.config = config
    this.tokens = config.burstPerSecond
    this.lastRefillTime = Date.now()
    this.dailyCount = 0
    this.dailyResetTime = this.getNextMidnight()
  }

  /**
   * Resolves when a request slot becomes available.
   * Rejects if daily limit is exceeded.
   */
  async acquire(): Promise<void> {
    this.resetDailyIfNeeded()

    if (this.dailyCount >= this.config.dailySoftLimit) {
      throw new Error(
        `Daily API quota soft limit reached (${this.config.dailySoftLimit}). ` +
          'Sync paused until next day.'
      )
    }

    this.refillTokens()

    if (this.tokens >= 1) {
      this.tokens -= 1
      this.dailyCount += 1
      return
    }

    // Wait until next token becomes available
    const waitMs = this.msUntilNextToken()
    await this.delay(waitMs)

    // Refill after wait and consume
    this.refillTokens()
    this.tokens = Math.max(0, this.tokens - 1)
    this.dailyCount += 1
  }

  getDailyUsage(): { used: number; limit: number; remaining: number } {
    this.resetDailyIfNeeded()
    return {
      used: this.dailyCount,
      limit: this.config.dailySoftLimit,
      remaining: Math.max(0, this.config.dailySoftLimit - this.dailyCount),
    }
  }

  isApproachingLimit(): boolean {
    return this.dailyCount >= this.config.dailySoftLimit * 0.8
  }

  private refillTokens(): void {
    const now = Date.now()
    const elapsedMs = now - this.lastRefillTime
    const refill = (elapsedMs / 1000) * this.config.burstPerSecond
    this.tokens = Math.min(this.config.burstPerSecond, this.tokens + refill)
    this.lastRefillTime = now
  }

  private msUntilNextToken(): number {
    return Math.ceil(1000 / this.config.burstPerSecond)
  }

  private resetDailyIfNeeded(): void {
    if (Date.now() >= this.dailyResetTime) {
      this.dailyCount = 0
      this.dailyResetTime = this.getNextMidnight()
    }
  }

  private getNextMidnight(): number {
    const tomorrow = new Date()
    tomorrow.setHours(24, 0, 0, 0)
    return tomorrow.getTime()
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
