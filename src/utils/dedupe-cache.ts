/**
 * Deduplication Cache with TTL and Size Limits
 *
 * Prevents duplicate message processing with automatic expiration and memory bounds.
 * Based on OpenClaw's dedupe pattern.
 */

export interface DedupeCache {
  /**
   * Check if a key was recently seen.
   * If not seen, marks it as seen and returns false (process it).
   * If seen within TTL, returns true (skip it).
   *
   * @param key - Unique identifier for the item (e.g., "whatsapp:chatId:messageId")
   * @param now - Optional timestamp (defaults to Date.now())
   * @returns true if duplicate (skip), false if new (process)
   */
  check: (key: string | undefined | null, now?: number) => boolean;

  /**
   * Clear all cached entries
   */
  clear: () => void;

  /**
   * Get current cache size
   */
  size: () => number;
}

export interface DedupeCacheOptions {
  /**
   * Time-to-live in milliseconds.
   * Entries older than this are pruned.
   * Default: 20 minutes (1,200,000 ms)
   */
  ttlMs: number;

  /**
   * Maximum number of entries.
   * When exceeded, oldest entries are removed.
   * Default: 5000
   */
  maxSize: number;
}

/**
 * Create a TTL-based deduplication cache with size limits.
 *
 * Features:
 * - Automatic expiration based on TTL
 * - Memory-bounded with max size enforcement
 * - Efficient pruning (only on insert)
 * - Thread-safe for single-threaded Node.js
 *
 * @param options - Cache configuration
 * @returns DedupeCache instance
 *
 * @example
 * const cache = createDedupeCache({
 *   ttlMs: 20 * 60 * 1000, // 20 minutes
 *   maxSize: 5000
 * });
 *
 * const key = `whatsapp:${chatId}:${messageId}`;
 * if (cache.check(key)) {
 *   console.log('Duplicate - skip');
 *   return;
 * }
 * console.log('New message - process');
 */
export function createDedupeCache(options: DedupeCacheOptions): DedupeCache {
  const cache = new Map<string, number>();
  const { ttlMs, maxSize } = options;

  /**
   * Remove expired entries and enforce size limit.
   * Called on every check() to keep cache clean.
   */
  const prune = (now: number): void => {
    // Remove expired entries
    for (const [key, timestamp] of cache.entries()) {
      if (now - timestamp > ttlMs) {
        cache.delete(key);
      }
    }

    // Enforce max size by removing oldest entries
    if (cache.size > maxSize) {
      // Sort by timestamp (oldest first)
      const sorted = Array.from(cache.entries()).sort((a, b) => a[1] - b[1]);
      const toDelete = sorted.slice(0, cache.size - maxSize);

      for (const [key] of toDelete) {
        cache.delete(key);
      }
    }
  };

  return {
    check: (key: string | undefined | null, now: number = Date.now()): boolean => {
      // Null/undefined keys are always considered new (not cached)
      if (!key) {
        return false;
      }

      const existing = cache.get(key);

      // Check if exists and not expired
      if (existing !== undefined && now - existing < ttlMs) {
        // Touch the entry (update timestamp for LRU-like behavior)
        cache.set(key, now);
        return true; // Duplicate
      }

      // New entry - mark as seen
      cache.set(key, now);

      // Prune on every insert (amortized O(1) with infrequent full scans)
      prune(now);

      return false; // Not a duplicate
    },

    clear: (): void => {
      cache.clear();
    },

    size: (): number => {
      return cache.size;
    },
  };
}

/**
 * Create a simple time-based cache for tracking recent items.
 * Simpler alternative to DedupeCache when you don't need size limits.
 *
 * @param ttlMs - Time-to-live in milliseconds
 * @returns Set-like interface with TTL
 *
 * @example
 * const recentIds = createTtlSet(60000); // 1 minute TTL
 *
 * recentIds.add('msg123');
 * console.log(recentIds.has('msg123')); // true
 *
 * // After 60 seconds
 * console.log(recentIds.has('msg123')); // false (expired)
 */
export function createTtlSet(ttlMs: number) {
  const cache = new Map<string, number>();

  return {
    add: (key: string): void => {
      cache.set(key, Date.now());
    },

    has: (key: string): boolean => {
      const timestamp = cache.get(key);
      if (!timestamp) return false;

      const now = Date.now();
      if (now - timestamp > ttlMs) {
        cache.delete(key);
        return false;
      }

      return true;
    },

    delete: (key: string): void => {
      cache.delete(key);
    },

    clear: (): void => {
      cache.clear();
    },

    size: (): number => {
      return cache.size;
    },
  };
}
