/**
 * WhatsApp Inbound Message Types
 *
 * Clean TypeScript interfaces for incoming WhatsApp messages.
 * Shields the rest of the codebase from Baileys proto complexity.
 */

import type { InboundAttachment } from "../../../core/types.js";

/**
 * Normalized inbound message from WhatsApp.
 * This interface is what the bot core receives - it abstracts away
 * all the Baileys proto complexity.
 */
export interface WebInboundMessage {
  /** Message ID from WhatsApp */
  id?: string;

  /** Sender identifier (E.164 for DMs, JID for groups) */
  from: string;

  /** Bot's own identifier */
  to: string;

  /** Chat identifier (JID) */
  chatId: string;

  /** Message text content */
  body: string;

  /** Sender's display name */
  pushName?: string;

  /** Message timestamp */
  timestamp: Date;

  /** Chat type */
  chatType: "direct" | "group";

  /** Group sender JID (only for group messages) */
  senderJid?: string;

  /** Group sender E.164 (resolved) */
  senderE164?: string;

  /** Group sender display name */
  senderName?: string;

  /** Reply context (if message is a reply) */
  replyContext?: {
    id?: string;
    body?: string;
    senderJid?: string;
    senderE164?: string;
  };

  /** Group chat subject/name */
  groupSubject?: string;

  /** Group participants (E.164 numbers) */
  groupParticipants?: string[];

  /** Mentioned JIDs (@mentions) */
  mentionedJids?: string[];

  /** Bot's own JID */
  selfJid: string;

  /** Bot's own E.164 number */
  selfE164?: string;

  /** Downloaded media file path */
  mediaPath?: string;

  /** Media MIME type */
  mediaType?: string;

  /** Whether this is a self-chat message */
  isSelfChat?: boolean;

  /** Whether sender mentioned the bot */
  wasMentioned?: boolean;

  /** Downloaded media attachments (images, videos, documents, etc.) */
  attachments?: InboundAttachment[];
}

/**
 * Configuration for attachment extraction during message processing
 */
export interface AttachmentExtractionConfig {
  downloadContentFromMessage: (message: any, type: string) => Promise<AsyncIterable<Uint8Array>>;
  attachmentsDir?: string;
  attachmentsMaxBytes?: number;
}

/**
 * Result of message filtering checks
 */
export interface MessageFilterResult {
  /** Whether message should be processed */
  process: boolean;

  /** Reason for filtering (if process=false) */
  reason?: "invalid-type" | "status-broadcast" | "self-sent" | "duplicate" | "history";
}

/**
 * Options for message extraction
 */
export interface ExtractOptions {
  /** Whether to download and include media */
  includeMedia?: boolean;

  /** Maximum media file size in bytes */
  maxMediaBytes?: number;

  /** Whether to resolve group metadata */
  resolveGroupMeta?: boolean;
}
