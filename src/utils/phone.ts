/**
 * Phone number normalization utilities
 *
 * Ensures consistent E.164 format (+countrycode+number) for WhatsApp/Signal contacts
 */

/**
 * Normalize a user ID to E.164 phone format for storage and comparison
 *
 * Handles:
 * - WhatsApp JIDs: 12345678901@s.whatsapp.net -> +12345678901
 * - LID contacts: 12345678901@lid -> +12345678901
 * - Group IDs: 120363001234567-1234567890@g.us -> +120363001234567-1234567890
 * - Raw numbers: 12345678901 -> +12345678901
 * - Already formatted: +12345678901 -> +12345678901
 *
 * @param userId - Raw user ID from WhatsApp/Signal
 * @returns Normalized E.164 format with + prefix
 */
export function normalizePhoneForStorage(userId: string): string {
  return userId
    .replace('@s.whatsapp.net', '')   // Strip WhatsApp DM suffix
    .replace('@g.us', '')              // Strip WhatsApp group suffix
    .replace('@lid', '')               // Strip LID suffix (linked device contact)
    .replace(/:\d+$/, '')              // Strip port suffix if present
    .trim()                            // Remove whitespace
    .replace(/^(?!\+)/, '+');          // Add + prefix if missing
}

/**
 * Check if two user IDs represent the same contact
 * Normalizes both before comparing
 *
 * @param id1 - First user ID
 * @param id2 - Second user ID
 * @returns true if they represent the same contact
 */
export function isSameContact(id1: string, id2: string): boolean {
  return normalizePhoneForStorage(id1) === normalizePhoneForStorage(id2);
}
