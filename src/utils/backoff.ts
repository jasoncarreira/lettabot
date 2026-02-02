/**
 * Exponential Backoff Utilities
 *
 * Provides reconnection primitives with exponential backoff and jitter.
 * Shared across all channel adapters (WhatsApp, Discord, Signal, etc.)
 *
 * Based on OpenClaw's backoff patterns.
 */

export interface BackoffPolicy {
  initialMs: number;  // Starting delay (e.g., 2000)
  maxMs: number;      // Maximum delay cap (e.g., 30000)
  factor: number;     // Exponential growth factor (e.g., 1.8)
  jitter: number;     // Random jitter factor 0-1 (e.g., 0.25 = ±25%)
}

export interface ReconnectPolicy extends BackoffPolicy {
  maxAttempts: number;  // Maximum reconnect attempts before giving up
}

/**
 * Default reconnect policy for real-time channels.
 * Starts at 2s, grows to max 30s, with 12 attempts max (~5-10 minutes total).
 */
export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  initialMs: 2000,
  maxMs: 30000,
  factor: 1.8,
  jitter: 0.25,
  maxAttempts: 12,
};

/**
 * Calculate backoff delay for a given attempt number using exponential backoff with jitter.
 *
 * Formula: min(maxMs, round(initialMs * factor^(attempt-1) + random_jitter))
 *
 * @param policy - Backoff configuration
 * @param attempt - Current attempt number (1-indexed)
 * @returns Delay in milliseconds
 *
 * @example
 * const delay = computeBackoff(DEFAULT_RECONNECT_POLICY, 1);
 * // Returns: ~2000ms ± 25% jitter
 *
 * const delay3 = computeBackoff(DEFAULT_RECONNECT_POLICY, 3);
 * // Returns: ~6480ms ± 25% jitter (2000 * 1.8^2)
 */
export function computeBackoff(policy: BackoffPolicy, attempt: number): number {
  const exponent = Math.max(attempt - 1, 0);
  const base = policy.initialMs * Math.pow(policy.factor, exponent);
  const jitterAmount = base * policy.jitter * Math.random();
  return Math.min(policy.maxMs, Math.round(base + jitterAmount));
}

/**
 * Sleep for a duration, but abort early if signal is triggered.
 * Useful for interruptible delays in reconnection loops.
 *
 * @param ms - Duration to sleep in milliseconds
 * @param signal - Optional AbortSignal to cancel the sleep
 * @throws Error with message "Aborted" if signal is triggered
 *
 * @example
 * const controller = new AbortController();
 * setTimeout(() => controller.abort(), 1000);
 *
 * try {
 *   await sleepWithAbort(5000, controller.signal); // Will abort after 1s
 * } catch (err) {
 *   console.log('Sleep was aborted');
 * }
 */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // Check if already aborted
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    const timeout = setTimeout(resolve, ms);

    // Listen for abort signal
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error('Aborted'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Create a reconnection manager with exponential backoff.
 * Returns an object that tracks state and calculates delays.
 *
 * @param policy - Reconnection policy with backoff and max attempts
 * @returns Manager with attempt tracking and delay calculation
 *
 * @example
 * const reconnect = createReconnectManager(DEFAULT_RECONNECT_POLICY);
 *
 * while (!reconnect.isExhausted()) {
 *   try {
 *     await connect();
 *     reconnect.reset(); // Reset on success
 *     break;
 *   } catch (err) {
 *     const delay = reconnect.nextDelay();
 *     await sleepWithAbort(delay, signal);
 *   }
 * }
 */
export function createReconnectManager(policy: ReconnectPolicy) {
  let attempts = 0;

  return {
    /**
     * Get current attempt number (1-indexed)
     */
    getAttempts: () => attempts,

    /**
     * Increment attempt counter and return new count
     */
    increment: () => ++attempts,

    /**
     * Reset attempt counter (call after successful connection)
     */
    reset: () => {
      attempts = 0;
    },

    /**
     * Check if max attempts reached
     */
    isExhausted: () => attempts >= policy.maxAttempts,

    /**
     * Calculate delay for next reconnection attempt.
     * Automatically increments attempt counter.
     */
    nextDelay: () => {
      attempts++;
      return computeBackoff(policy, attempts);
    },

    /**
     * Get current policy
     */
    getPolicy: () => policy,
  };
}
