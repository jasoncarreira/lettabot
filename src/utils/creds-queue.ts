/**
 * Credentials Save Queue with Backup
 *
 * Sequential queue for saving credentials with automatic backup and validation.
 * Prevents concurrent writes and enables recovery after crashes.
 *
 * Based on OpenClaw's credential management pattern.
 */

import { existsSync, readFileSync, copyFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface CredsSaveQueueOptions {
  /**
   * Directory containing credentials files
   */
  authDir: string;

  /**
   * Name of the main credentials file (default: "creds.json")
   */
  credsFilename?: string;

  /**
   * Name of the backup file (default: "creds.json.backup")
   */
  backupFilename?: string;

  /**
   * Optional logger for warnings
   */
  logger?: {
    warn: (message: string, error?: unknown) => void;
  };
}

export interface CredsSaveQueue {
  /**
   * Enqueue a save operation.
   * Operations are processed sequentially with backup before save.
   */
  enqueue: (saveCreds: () => Promise<void> | void) => void;

  /**
   * Wait for all pending saves to complete
   */
  flush: () => Promise<void>;
}

/**
 * Read and validate a JSON credentials file.
 *
 * @param filePath - Path to credentials file
 * @returns Raw JSON string if valid, null otherwise
 */
function readCredsJsonRaw(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) {
      return null;
    }

    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size <= 1) {
      return null;
    }

    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Safely save credentials with backup.
 *
 * Process:
 * 1. Read current creds.json
 * 2. Validate it's valid JSON
 * 3. Backup to creds.json.backup
 * 4. Execute save operation
 *
 * Important: Don't overwrite a good backup with corrupted credentials.
 *
 * @param authDir - Directory containing credentials
 * @param saveCreds - Save operation to execute
 * @param options - Configuration
 */
async function safeSaveCreds(
  authDir: string,
  saveCreds: () => Promise<void> | void,
  options: {
    credsFilename: string;
    backupFilename: string;
    logger?: { warn: (message: string, error?: unknown) => void };
  }
): Promise<void> {
  const credsPath = resolve(authDir, options.credsFilename);
  const backupPath = resolve(authDir, options.backupFilename);

  // Best-effort backup before saving
  try {
    const raw = readCredsJsonRaw(credsPath);
    if (raw) {
      try {
        JSON.parse(raw); // Validate JSON
        copyFileSync(credsPath, backupPath);
      } catch (parseErr) {
        // Current creds are corrupted - keep existing backup
        options.logger?.warn(
          "Current credentials file is corrupted, preserving existing backup",
          parseErr
        );
      }
    }
  } catch (backupErr) {
    // Ignore backup failures - not critical
    options.logger?.warn("Failed to backup credentials (non-critical)", backupErr);
  }

  // Execute the save operation
  try {
    await Promise.resolve(saveCreds());
  } catch (saveErr) {
    options.logger?.warn("Failed to save credentials", saveErr);
    throw saveErr;
  }
}

/**
 * Create a sequential save queue for credentials.
 *
 * Ensures only one save operation runs at a time, with automatic backup
 * before each save. This prevents concurrent write corruption and enables
 * recovery after crashes.
 *
 * @param options - Queue configuration
 * @returns CredsSaveQueue instance
 *
 * @example
 * const queue = createCredsSaveQueue({
 *   authDir: './data/whatsapp-session'
 * });
 *
 * // Enqueue saves (non-blocking)
 * sock.ev.on('creds.update', () => queue.enqueue(saveCreds));
 *
 * // Wait for all saves to complete (e.g., before shutdown)
 * await queue.flush();
 */
export function createCredsSaveQueue(options: CredsSaveQueueOptions): CredsSaveQueue {
  let queue: Promise<void> = Promise.resolve();

  const credsFilename = options.credsFilename ?? "creds.json";
  const backupFilename = options.backupFilename ?? "creds.json.backup";

  return {
    enqueue: (saveCreds: () => Promise<void> | void): void => {
      queue = queue
        .then(() =>
          safeSaveCreds(options.authDir, saveCreds, {
            credsFilename,
            backupFilename,
            logger: options.logger,
          })
        )
        .catch((err) => {
          options.logger?.warn("Credential save queue error", err);
        });
    },

    flush: async (): Promise<void> => {
      await queue;
    },
  };
}

/**
 * Attempt to restore credentials from backup if main file is corrupted.
 *
 * @param authDir - Directory containing credentials
 * @param options - Configuration
 * @returns true if restored from backup, false otherwise
 *
 * @example
 * // Before loading auth state
 * const restored = maybeRestoreCredsFromBackup('./data/whatsapp-session');
 * if (restored) {
 *   console.log('Recovered credentials from backup');
 * }
 *
 * // Then load auth state normally
 * const { state, saveCreds } = await useMultiFileAuthState(authDir);
 */
export function maybeRestoreCredsFromBackup(
  authDir: string,
  options: {
    credsFilename?: string;
    backupFilename?: string;
    logger?: { log: (message: string) => void; warn: (message: string, error?: unknown) => void };
  } = {}
): boolean {
  const credsFilename = options.credsFilename ?? "creds.json";
  const backupFilename = options.backupFilename ?? "creds.json.backup";

  const credsPath = resolve(authDir, credsFilename);
  const backupPath = resolve(authDir, backupFilename);

  // Try to validate main file
  try {
    const raw = readCredsJsonRaw(credsPath);
    if (raw) {
      JSON.parse(raw); // Validate
      return false; // Main file is good
    }
  } catch {
    // Main file is corrupted or missing
  }

  // Try to restore from backup
  try {
    const backupRaw = readCredsJsonRaw(backupPath);
    if (backupRaw) {
      JSON.parse(backupRaw); // Validate backup
      copyFileSync(backupPath, credsPath);
      options.logger?.log("Restored credentials from backup");
      return true;
    }
  } catch (err) {
    options.logger?.warn("Failed to restore credentials from backup", err);
  }

  return false;
}
