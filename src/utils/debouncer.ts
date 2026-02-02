/**
 * Message Debouncing Utility
 *
 * Batches rapid consecutive messages from the same sender.
 * Based on OpenClaw's inbound-debounce pattern.
 */

/**
 * Debounce buffer for a specific key (conversation + sender)
 */
interface DebounceBuffer<T> {
  items: T[];
  timeout: ReturnType<typeof setTimeout> | null;
}

/**
 * Debouncer interface
 */
export interface Debouncer<T> {
  /**
   * Enqueue an item for debouncing.
   * If debouncing is disabled or item shouldn't be debounced, processes immediately.
   */
  enqueue: (item: T) => Promise<void>;

  /**
   * Flush all pending items for a specific key immediately.
   */
  flushKey: (key: string) => Promise<void>;

  /**
   * Flush all pending items across all keys.
   */
  flushAll: () => Promise<void>;
}

/**
 * Parameters for creating an inbound debouncer
 */
export interface DebouncerOptions<T> {
  /**
   * Debounce window in milliseconds.
   * Messages within this window are batched together.
   * Set to 0 to disable debouncing.
   */
  debounceMs: number;

  /**
   * Build a unique key for an item.
   * Items with the same key are debounced together.
   * Return null/undefined to skip debouncing for this item.
   *
   * @example
   * buildKey: (msg) => `${msg.chatId}:${msg.userId}`
   */
  buildKey: (item: T) => string | null | undefined;

  /**
   * Optional predicate to determine if item should be debounced.
   * Return false to process immediately even if debounceMs > 0.
   *
   * @example
   * shouldDebounce: (msg) => !msg.mediaPath && !msg.text.startsWith('/')
   */
  shouldDebounce?: (item: T) => boolean;

  /**
   * Callback to process batched items.
   * Called with array of items after debounce window expires.
   */
  onFlush: (items: T[]) => Promise<void>;

  /**
   * Optional error handler for flush failures.
   */
  onError?: (err: unknown, items: T[]) => void;
}

/**
 * Create an inbound message debouncer.
 *
 * Batches rapid consecutive messages from the same sender (conversation + user)
 * to reduce agent session overhead and improve user experience.
 *
 * @param options - Debouncer configuration
 * @returns Debouncer instance
 *
 * @example
 * const debouncer = createInboundDebouncer({
 *   debounceMs: 2000, // 2 second window
 *   buildKey: (msg) => `${msg.chatId}:${msg.userId}`,
 *   shouldDebounce: (msg) => !msg.mediaPath, // Don't debounce media
 *   onFlush: async (messages) => {
 *     // Combine messages and process
 *     const combined = {
 *       ...messages[messages.length - 1],
 *       text: messages.map(m => m.text).join('\n')
 *     };
 *     await processMessage(combined);
 *   },
 *   onError: (err, items) => {
 *     console.error('Debounce error:', err);
 *   }
 * });
 *
 * // Usage:
 * await debouncer.enqueue(inboundMessage);
 */
export function createInboundDebouncer<T>(
  options: DebouncerOptions<T>
): Debouncer<T> {
  const buffers = new Map<string, DebounceBuffer<T>>();
  const debounceMs = Math.max(0, Math.trunc(options.debounceMs));

  /**
   * Flush a specific buffer
   */
  const flushBuffer = async (key: string, buffer: DebounceBuffer<T>): Promise<void> => {
    // Remove from map
    buffers.delete(key);

    // Clear timeout
    if (buffer.timeout) {
      clearTimeout(buffer.timeout);
      buffer.timeout = null;
    }

    // Nothing to flush
    if (buffer.items.length === 0) {
      return;
    }

    // Process items
    try {
      await options.onFlush(buffer.items);
    } catch (err) {
      options.onError?.(err, buffer.items);
    }
  };

  /**
   * Flush items for a specific key
   */
  const flushKey = async (key: string): Promise<void> => {
    const buffer = buffers.get(key);
    if (!buffer) {
      return;
    }
    await flushBuffer(key, buffer);
  };

  /**
   * Schedule a flush for a buffer
   */
  const scheduleFlush = (key: string, buffer: DebounceBuffer<T>): void => {
    // Clear existing timeout
    if (buffer.timeout) {
      clearTimeout(buffer.timeout);
    }

    // Schedule new flush
    buffer.timeout = setTimeout(() => {
      void flushBuffer(key, buffer);
    }, debounceMs);

    // Allow process to exit even if timeout is pending
    buffer.timeout.unref?.();
  };

  /**
   * Enqueue an item for debouncing
   */
  const enqueue = async (item: T): Promise<void> => {
    const key = options.buildKey(item);
    const canDebounce = debounceMs > 0 && (options.shouldDebounce?.(item) ?? true);

    // Process immediately if debouncing disabled or item shouldn't be debounced
    if (!canDebounce || !key) {
      // Flush any pending items with this key first
      if (key && buffers.has(key)) {
        await flushKey(key);
      }

      // Process this item immediately
      await options.onFlush([item]);
      return;
    }

    // Add to existing buffer
    const existing = buffers.get(key);
    if (existing) {
      existing.items.push(item);
      scheduleFlush(key, existing); // Reschedule (extends window)
      return;
    }

    // Create new buffer
    const buffer: DebounceBuffer<T> = {
      items: [item],
      timeout: null,
    };
    buffers.set(key, buffer);
    scheduleFlush(key, buffer);
  };

  /**
   * Flush all pending buffers
   */
  const flushAll = async (): Promise<void> => {
    const keys = Array.from(buffers.keys());
    await Promise.all(keys.map((key) => flushKey(key)));
  };

  return {
    enqueue,
    flushKey,
    flushAll,
  };
}
