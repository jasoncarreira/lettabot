/**
 * WhatsApp Channel Adapter (Refactored)
 *
 * This file orchestrates the WhatsApp adapter using extracted modules.
 * It handles:
 * - Adapter lifecycle (start/stop)
 * - Monitor loop and reconnection logic
 * - Watchdog for detecting stale connections
 * - Crypto error handling
 * - Event delegation to extracted modules
 *
 * Extracted responsibilities:
 * - Socket creation -> session.ts
 * - Message extraction -> inbound/extract.ts
 * - Access control -> inbound/access-control.ts
 * - Message sending -> outbound.ts
 * - Utilities -> utils.ts
 */

import type { ChannelAdapter } from './types.js';
import type { InboundMessage, OutboundFile, OutboundMessage } from '../core/types.js';
import type {
  WhatsAppConfig,
  ReconnectState,
  ListenerRefs,
  BaileysSocket,
  BaileysMessage,
  BaileysDisconnectReasonType,
  MessagesUpsertData,
} from './whatsapp/types.js';
import type { CredsSaveQueue } from '../utils/creds-queue.js';

// Session management
import { createWaSocket, type SocketResult } from './whatsapp/session.js';

// Inbound message handling
import { extractInboundMessage } from './whatsapp/inbound/extract.js';
import {
  checkInboundAccess,
  formatPairingMessage,
} from './whatsapp/inbound/access-control.js';

// Outbound message handling
import {
  sendWhatsAppMessage,
  sendWhatsAppFile,
  sendTypingIndicator,
  sendReadReceipt,
  type LidMapper,
} from './whatsapp/outbound.js';

// Utilities
import {
  jidToE164,
  isSelfChatMessage,
  createGroupMetaCache,
  isStatusOrBroadcast,
  isLid,
  type GroupMetaCache,
} from './whatsapp/utils.js';

// Shared utilities
import {
  computeBackoff,
  sleepWithAbort,
  DEFAULT_RECONNECT_POLICY,
} from '../utils/backoff.js';
import { createDedupeCache, type DedupeCache } from '../utils/dedupe-cache.js';
import { createInboundDebouncer, type Debouncer } from '../utils/debouncer.js';
import { normalizePhoneForStorage } from '../utils/phone.js';

// Node imports
import { rmSync } from 'node:fs';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Watchdog check interval (1 minute) */
const WATCHDOG_INTERVAL_MS = 60 * 1000;

/** Watchdog timeout - force reconnect if no messages received (30 minutes) */
const WATCHDOG_TIMEOUT_MS = 30 * 60 * 1000;

/** Session corruption threshold - clear session after N failures without QR */
const SESSION_CORRUPTION_THRESHOLD = 3;

/** Message deduplication TTL (20 minutes) */
const DEDUPE_TTL_MS = 20 * 60 * 1000;

/** Maximum dedupe cache size */
const DEDUPE_MAX_SIZE = 5000;

/** Sent message ID cleanup delay (1 minute) */
const SENT_MESSAGE_CLEANUP_MS = 60 * 1000;

/** Stop timeout (5 seconds) */
const STOP_TIMEOUT_MS = 5000;

/** Uptime threshold for resetting reconnect attempts (1 minute) */
const STABLE_CONNECTION_MS = 60 * 1000;

// ============================================================================
// ADAPTER CLASS
// ============================================================================

export class WhatsAppAdapter implements ChannelAdapter {
  readonly id = 'whatsapp' as const;
  readonly name = 'WhatsApp';

  private config: WhatsAppConfig;
  private running = false;
  private sessionPath: string;

  // Socket state
  private sock: BaileysSocket | null = null;
  private DisconnectReason: BaileysDisconnectReasonType | null = null;
  private myJid: string = '';
  private myNumber: string = '';

  // LID mapping for message sending
  private selfChatLid: string = '';
  private lidToJid: Map<string, string> = new Map();

  // Message tracking
  private sentMessageIds: Set<string> = new Set();
  private dedupeCache: DedupeCache;
  private debouncer: Debouncer<InboundMessage>;

  // Group metadata cache
  private groupMetaCache: GroupMetaCache;

  // Message store for getMessage callback (populated when we SEND, not receive)
  private messageStore: Map<string, any> = new Map();

  // Attachment configuration
  private attachmentsDir?: string;
  private attachmentsMaxBytes?: number;
  private downloadContentFromMessage?: (message: any, type: string) => Promise<AsyncIterable<Uint8Array>>;

  // Reconnect state
  private reconnectState: ReconnectState = {
    attempts: 0,
    lastDisconnect: null,
    abortController: null,
    monitorTask: null,
  };

  // Watchdog timer for detecting stale connections
  private watchdogTimer: NodeJS.Timeout | null = null;
  private lastMessageTime: Date | null = null;

  // Connection timestamp (for filtering old messages on reconnect)
  private connectedAtMs: number = 0;

  // Event listener references
  private listenerRefs: ListenerRefs = {};

  // Crypto error handler
  private cryptoErrorHandler: ((reason: any) => void) | null = null;

  // Disconnect signal for monitor loop
  private disconnectSignal: (() => void) | null = null;

  // Consecutive failures without QR (session corruption indicator)
  private consecutiveNoQrFailures = 0;

  // Credential save queue
  private credsSaveQueue: CredsSaveQueue | null = null;

  // Event handler (set by bot core)
  onMessage?: (msg: InboundMessage) => Promise<void>;

  // Pre-bound handlers (created once to avoid bind() overhead)
  private boundHandleConnectionUpdate: (update: Partial<import('@whiskeysockets/baileys').ConnectionState>) => void;
  private boundHandleMessagesUpsert: (data: MessagesUpsertData) => void;

  constructor(config: WhatsAppConfig) {
    this.config = {
      ...config,
      dmPolicy: config.dmPolicy || 'pairing',
    };
    this.sessionPath = config.sessionPath || './data/whatsapp-session';

    // Initialize dedupe cache
    this.dedupeCache = createDedupeCache({
      ttlMs: DEDUPE_TTL_MS,
      maxSize: DEDUPE_MAX_SIZE,
    });

    // Initialize group metadata cache
    this.groupMetaCache = createGroupMetaCache();

    // Initialize attachment configuration
    this.attachmentsDir = config.attachmentsDir;
    this.attachmentsMaxBytes = config.attachmentsMaxBytes;

    // Initialize message debouncer (batches rapid consecutive messages)
    this.debouncer = createInboundDebouncer({
      debounceMs: 2000, // 2 second window
      onFlush: async (messages) => {
        for (const message of messages) {
          await this.onMessage?.(message);
        }
      },
    });

    // Bind handlers once
    this.boundHandleConnectionUpdate = (update) => this.handleConnectionUpdate(update);
    this.boundHandleMessagesUpsert = (data) => this.handleMessagesUpsert(data);
  }

  async start(): Promise<void> {
    if (this.running) return;

    await this.connect();
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;
    this.stopWatchdog();
    await this.cleanupListeners();
    this.disconnectSignal?.();

    if (this.sock) {
      await this.sock.logout();
      this.sock = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId: string }> {
    if (!this.sock) throw new Error('WhatsApp not connected');

    // Build LID mapper
    const lidMapper: LidMapper = {
      selfChatLid: this.selfChatLid,
      myNumber: this.myNumber,
      lidToJid: this.lidToJid,
      messageStore: this.messageStore, // Pass store for saving sent messages
    };

    // Delegate to extracted module
    return await sendWhatsAppMessage(
      this.sock,
      msg,
      lidMapper,
      this.sentMessageIds
    );
  }

  supportsEditing(): boolean {
    return false;
  }

  async editMessage(
    _chatId: string,
    _messageId: string,
    _text: string
  ): Promise<void> {
    // WhatsApp doesn't support editing messages - no-op
  }

  async addReaction(_chatId: string, _messageId: string, _emoji: string): Promise<void> {
    // WhatsApp reactions via Baileys are not supported here yet
  }

  async sendFile(file: OutboundFile): Promise<{ messageId: string }> {
    if (!this.sock) {
      throw new Error('WhatsApp not connected');
    }

    const lidMapper: LidMapper = {
      selfChatLid: this.selfChatLid,
      myNumber: this.myNumber,
      lidToJid: this.lidToJid,
      messageStore: this.messageStore,
    };

    return await sendWhatsAppFile(this.sock, file, lidMapper, this.sentMessageIds);
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    if (!this.sock) return;
    await sendTypingIndicator(this.sock, chatId);
  }

  private async connect(): Promise<void> {
    this.running = true;

    const socketResult = await createWaSocket({
      config: this.config,
      sessionPath: this.sessionPath,
      onConnectionUpdate: this.boundHandleConnectionUpdate,
      onMessagesUpsert: this.boundHandleMessagesUpsert,
      onCredsSaveQueue: (queue) => {
        this.credsSaveQueue = queue;
      },
    });

    this.sock = socketResult.socket;
    this.DisconnectReason = socketResult.DisconnectReason;
    this.downloadContentFromMessage = socketResult.downloadContentFromMessage;

    this.attachListeners();
    this.startWatchdog();
  }

  private async handleConnectionUpdate(update: Partial<import('@whiskeysockets/baileys').ConnectionState>): Promise<void> {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      this.onConnectionOpen();
      return;
    }

    if (connection === 'close') {
      await this.onConnectionClose(lastDisconnect);
    }
  }

  private onConnectionOpen(): void {
    if (!this.sock) return;

    this.running = true;
    this.connectedAtMs = Date.now();
    this.resetReconnectState();
    this.lastMessageTime = new Date();

    this.myJid = this.sock.user?.id || '';
    this.myNumber = jidToE164(this.myJid);

    if (this.sock.user?.lid) {
      this.selfChatLid = this.sock.user.lid;
      this.lidToJid.set(this.selfChatLid, this.myJid);
    }

    console.log(`[WhatsApp] Connected as ${this.myNumber || this.myJid}`);
  }

  private async onConnectionClose(lastDisconnect: any): Promise<void> {
    const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;

    if (!this.DisconnectReason) return;

    if (statusCode === this.DisconnectReason.loggedOut) {
      console.warn('[WhatsApp] Logged out. Clearing session.');
      this.cleanupSession();
      return;
    }

    await this.scheduleReconnect(lastDisconnect);
  }

  private async handleMessagesUpsert(data: MessagesUpsertData): Promise<void> {
    const { messages, type } = data;
    if (type !== 'notify') return;
    if (!this.sock) return;

    for (const message of messages) {
      if (!message.message) continue;

      // Drop broadcast/status messages
      if (isStatusOrBroadcast(message)) {
        continue;
      }

      // Skip messages we sent (prevents loop in selfChatMode)
      const messageId = message.key?.id || '';
      if (messageId && this.sentMessageIds.has(messageId)) {
        this.sentMessageIds.delete(messageId);
        continue;
      }

      // Ignore old messages from before we reconnected
      const messageTimestamp = Number(message.messageTimestamp || 0) * 1000;
      if (this.connectedAtMs && messageTimestamp < this.connectedAtMs - 1000) {
        continue;
      }

      const sender = message.key?.participant || message.key?.remoteJid || '';
      if (!sender) continue;

      // Update watchdog timestamp
      this.lastMessageTime = new Date();

      // Dedupe incoming messages
      if (this.dedupeCache.has(messageId)) {
        continue;
      }
      if (messageId) {
        this.dedupeCache.add(messageId);
      }

      // Update LID mapping when available
      if (isLid(sender) && message.key?.remoteJid) {
        this.lidToJid.set(sender, message.key.remoteJid);
      }

      // Skip self messages if not in self-chat mode
      if (!this.config.selfChatMode && isSelfChatMessage(message, this.myJid)) {
        continue;
      }

      const accessResult = await checkInboundAccess(
        this.config,
        sender,
        message,
        this.sock,
        this.credsSaveQueue,
        this.myNumber
      );

      if (accessResult.status === 'blocked') {
        continue;
      }

      if (accessResult.status === 'pairing') {
        const pairingMessage = formatPairingMessage(accessResult.code);
        if (accessResult.replyJid && pairingMessage) {
          await this.sock.sendMessage(accessResult.replyJid, { text: pairingMessage });
        }
        continue;
      }

      const inbound = await extractInboundMessage({
        message,
        sock: this.sock,
        config: this.config,
        groupMetaCache: this.groupMetaCache,
        downloadContentFromMessage: this.downloadContentFromMessage,
        attachmentsDir: this.attachmentsDir,
        attachmentsMaxBytes: this.attachmentsMaxBytes,
      });

      if (!inbound) {
        continue;
      }

      // Normalize chat and user IDs
      inbound.chatId = normalizePhoneForStorage(inbound.chatId);
      inbound.userId = normalizePhoneForStorage(inbound.userId);

      // Mark as read
      try {
        await sendReadReceipt(this.sock, message);
      } catch (err) {
        console.warn('[WhatsApp] Failed to send read receipt:', err);
      }

      await this.debouncer.add(inbound);
    }
  }

  private attachListeners(): void {
    if (!this.sock) return;

    const socket = this.sock;

    this.listenerRefs.connectionUpdate = this.boundHandleConnectionUpdate;
    this.listenerRefs.messagesUpsert = this.boundHandleMessagesUpsert;

    socket.ev.on('connection.update', this.boundHandleConnectionUpdate);
    socket.ev.on('messages.upsert', this.boundHandleMessagesUpsert);
  }

  private async cleanupListeners(): Promise<void> {
    if (!this.sock) return;

    const socket = this.sock;

    if (this.listenerRefs.connectionUpdate) {
      socket.ev.off('connection.update', this.listenerRefs.connectionUpdate);
      this.listenerRefs.connectionUpdate = undefined;
    }

    if (this.listenerRefs.messagesUpsert) {
      socket.ev.off('messages.upsert', this.listenerRefs.messagesUpsert);
      this.listenerRefs.messagesUpsert = undefined;
    }
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(() => {
      if (!this.lastMessageTime || !this.sock) return;
      const elapsedMs = Date.now() - this.lastMessageTime.getTime();
      if (elapsedMs > WATCHDOG_TIMEOUT_MS) {
        console.warn('[WhatsApp] Watchdog timeout, forcing reconnect');
        this.sock?.end(new Error('Watchdog timeout'));
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private async scheduleReconnect(lastDisconnect: any): Promise<void> {
    if (!this.running) return;

    this.reconnectState.attempts += 1;
    this.reconnectState.lastDisconnect = lastDisconnect;

    if (this.reconnectState.attempts >= SESSION_CORRUPTION_THRESHOLD) {
      console.warn('[WhatsApp] Too many failed reconnects, clearing session.');
      this.cleanupSession();
      return;
    }

    const policy = this.config.reconnectPolicy || DEFAULT_RECONNECT_POLICY;
    const delayMs = computeBackoff(this.reconnectState.attempts, policy);

    console.log(`[WhatsApp] Scheduling reconnect in ${Math.round(delayMs / 1000)}s`);

    this.disconnectSignal?.();
    const abortController = new AbortController();
    this.reconnectState.abortController = abortController;

    const monitorTask = (async () => {
      try {
        await sleepWithAbort(delayMs, abortController.signal);
        if (!this.running) return;
        await this.connect();
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          console.warn('[WhatsApp] Reconnect sleep aborted:', err);
        }
      }
    })();

    this.reconnectState.monitorTask = monitorTask;
  }

  private resetReconnectState(): void {
    this.reconnectState.attempts = 0;
    this.reconnectState.lastDisconnect = null;
    this.reconnectState.abortController?.abort();
    this.reconnectState.abortController = null;
    this.reconnectState.monitorTask = null;
    this.consecutiveNoQrFailures = 0;
  }

  private cleanupSession(): void {
    try {
      rmSync(this.sessionPath, { recursive: true, force: true });
    } catch (err) {
      console.warn('[WhatsApp] Failed to remove session folder:', err);
    }
    this.sock?.end(new Error('Session cleared'));
    this.sock = null;
  }
}

export type { WhatsAppConfig };
