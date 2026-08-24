/**
 * Event processor for webhook DM events.
 *
 * Normalizes both X Activity API (dm.received/dm.sent) and legacy Account Activity
 * (direct_message_events) payload shapes into a single internal DmEvent type.
 *
 * Dedupes by event_id against dm_events_log before inserting.
 * Ignores events where sender_id === X_BOT_USER_ID (own echoes).
 *
 * Spec: X_DM_REFINEMENT_SPEC.md §5.2, §5.7, §7.6
 *
 * TODO(§7.6): Log the first real webhook payload to determine whether X delivers
 * as X Activity `dm.*` envelopes or legacy Account Activity `direct_message_events`
 * shape. The parser is written to tolerate both, but field names may differ.
 */

import { getConfig } from './config.js';
import { insertDmEvent, eventExists, kvSet, KV_KEYS } from './db.js';
import { sendDm } from './dmSender.js';
import { claimReplyForPhoto } from './photoClaim.js';

// ---------------------------------------------------------------------------
// Internal DmEvent type (normalized)
// ---------------------------------------------------------------------------

export interface DmEvent {
  event_id: string;
  dm_conversation_id: string;
  sender_id: string;
  /** The X user who sent the event */
  sender_username?: string;
  /** Recipient id from legacy shapes — used for A16 (participantId) fallback */
  participant_id?: string;
  event_type: 'MessageCreate' | 'ParticipantsJoin' | 'ParticipantsLeave' | string;
  text: string | null;
  media_keys: string[] | null;
  /** Raw payload for debugging/replay */
  raw: unknown;
  /** Timestamp from X (ISO-ish string) */
  created_at: string;
}

// ---------------------------------------------------------------------------
// Payload shape detection
// ---------------------------------------------------------------------------

/**
 * Try to parse a webhook payload as an X Activity API envelope
 * (dm.received, dm.sent, etc.).
 *
 * X Activity shape (expected):
 *   {
 *     "dm_event": {
 *       "id": "...",
 *       "text": "...",
 *       "event_type": "MessageCreate",
 *       "dm_conversation_id": "...",
 *       "sender_id": "...",
 *       "created_at": "...",
 *       "attachments": { "media_keys": ["..."] }
 *     },
 *     "users": { "...": { "username": "...", ... } }
 *   }
 */
function tryParseXActivityEnvelope(payload: Record<string, unknown>): DmEvent | null {
  const dmEvent = payload.dm_event as Record<string, unknown> | undefined;
  if (!dmEvent) return null;

  const eventId = dmEvent.id as string | undefined;
  if (!eventId) return null;

  const senderId = dmEvent.sender_id as string | undefined;
  const convId = dmEvent.dm_conversation_id as string | undefined;
  const eventType = dmEvent.event_type as string | undefined;
  const text = dmEvent.text as string | null | undefined;
  const createdAt = dmEvent.created_at as string | undefined;

  // Extract media keys
  let mediaKeys: string[] | null = null;
  const attachments = dmEvent.attachments as Record<string, unknown> | undefined;
  if (attachments?.media_keys) {
    mediaKeys = (attachments.media_keys as string[]) ?? null;
  }

  // Look up username from the users map if available
  const users = payload.users as Record<string, { username?: string }> | undefined;
  const senderUsername = senderId ? users?.[senderId]?.username : undefined;

  return {
    event_id: eventId,
    dm_conversation_id: convId ?? '',
    sender_id: senderId ?? '',
    sender_username: senderUsername,
    event_type: eventType ?? 'MessageCreate',
    text: text ?? null,
    media_keys: mediaKeys,
    raw: payload,
    created_at: createdAt ?? new Date().toISOString(),
  };
}

/**
 * Try to parse a webhook payload as a legacy Account Activity envelope
 * (direct_message_events).
 *
 * Legacy shape:
 *   {
 *     "direct_message_events": [
 *       {
 *         "id": "...",
 *         "created_timestamp": "...",
 *         "type": "message_create",
 *         "message_create": {
 *           "sender_id": "...",
 *           "target": { "recipient_id": "..." },
 *           "message_data": {
 *             "text": "...",
 *             "attachment": {
 *               "media": { "media_url": "...", ... }
 *             }
 *           }
 *         }
 *       }
 *     ],
 *     "users": { "...": { "screen_name": "...", ... } }
 *   }
 */
function tryParseLegacyEnvelope(payload: Record<string, unknown>): DmEvent[] {
  const events = payload.direct_message_events as unknown[] | undefined;
  if (!events || !Array.isArray(events)) return [];

  const users = payload.users as Record<string, { screen_name?: string }> | undefined;
  const results: DmEvent[] = [];

  for (const raw of events) {
    const ev = raw as Record<string, unknown>;
    const eventId = ev.id as string | undefined;
    if (!eventId) continue;

    const msgCreate = ev.message_create as Record<string, unknown> | undefined;
    if (!msgCreate) continue;

    const senderId = msgCreate.sender_id as string | undefined;
    const msgData = msgCreate.message_data as Record<string, unknown> | undefined;
    const text = msgData?.text as string | undefined;

    // Legacy events don't have dm_conversation_id directly; derive from sender_id
    const convId = ev.dm_conversation_id as string | undefined;
    const createdTimestamp = ev.created_timestamp as string | undefined;

    // Extract media
    let mediaKeys: string[] | null = null;
    const attachment = msgData?.attachment as Record<string, unknown> | undefined;
    const media = attachment?.media as Record<string, unknown> | undefined;
    if (media?.id_str) {
      mediaKeys = [media.id_str as string];
    } else if (media?.id) {
      mediaKeys = [String(media.id)];
    }

    // Event type — legacy uses "message_create" for DMs
    const eventType = (ev.type as string) === 'message_create' ? 'MessageCreate' : (ev.type as string || 'MessageCreate');

    const senderUsername = senderId ? users?.[senderId]?.screen_name : undefined;

    results.push({
      event_id: eventId,
      dm_conversation_id: convId ?? '',
      sender_id: senderId ?? '',
      sender_username: senderUsername,
      event_type: eventType,
      text: text ?? null,
      media_keys: mediaKeys,
      raw: ev,
      created_at: createdTimestamp
        ? new Date(Number(createdTimestamp)).toISOString()
        : new Date().toISOString(),
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Data payload envelope (production shape)
// ---------------------------------------------------------------------------

/**
 * Try to parse a webhook payload as an X Activity envelope where the
 * subscription event wraps a legacy payload:
 *
 *   {
 *     "data": {
 *       "event_uuid": "...",
 *       "filter": { "user_id": "..." },
 *       "event_type": "dm.received",
 *       "tag": "...",
 *       "payload": {
 *         "direct_message_events": [ ... ],
 *         "users": { ... }
 *       }
 *     }
 *   }
 *
 * This is the REAL production shape — detect by `data.event_type` starting
 * with `dm.` AND `data.payload.direct_message_events` existing.
 */
function tryParseDataPayloadEnvelope(payload: Record<string, unknown>): DmEvent[] {
  const data = payload.data as Record<string, unknown> | undefined;
  if (!data) return [];

  const eventType = data.event_type as string | undefined;
  if (!eventType || !eventType.startsWith('dm.')) return [];

  const payloadObj = data.payload as Record<string, unknown> | undefined;
  if (!payloadObj) return [];

  const directEvents = payloadObj.direct_message_events as unknown[] | undefined;
  if (!directEvents || !Array.isArray(directEvents) || directEvents.length === 0) return [];

  const users = payloadObj.users as Record<string, { screen_name?: string }> | undefined;
  const results: DmEvent[] = [];

  for (const raw of directEvents) {
    const ev = raw as Record<string, unknown>;
    const eventId = ev.id as string | undefined;
    if (!eventId) continue;

    const msgCreate = ev.message_create as Record<string, unknown> | undefined;
    if (!msgCreate) continue;

    const senderId = msgCreate.sender_id as string | undefined;
    const recipientId = (msgCreate.target as Record<string, unknown> | undefined)
      ?.recipient_id as string | undefined;
    const msgData = msgCreate.message_data as Record<string, unknown> | undefined;
    const text = msgData?.text as string | undefined;
    const createdTimestamp = ev.created_timestamp as string | undefined;

    // Legacy events lack dm_conversation_id — derive a 1:1 convention
    // from sender/recipient numeric ids: `${min}-${max}`
    let convId = ev.dm_conversation_id as string | undefined;
    if (!convId && senderId && recipientId) {
      const sorted = [senderId, recipientId].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      convId = `${sorted[0]}-${sorted[1]}`;
    }

    // Extract media (message_data.attachment.media)
    let mediaKeys: string[] | null = null;
    const attachment = msgData?.attachment as Record<string, unknown> | undefined;
    const attachmentMedia = attachment?.media as Record<string, unknown> | undefined;
    if (attachmentMedia?.media_url_https) {
      mediaKeys = [attachmentMedia.media_url_https as string];
    } else if (attachmentMedia?.id_str) {
      mediaKeys = [attachmentMedia.id_str as string];
    } else if (attachmentMedia?.id) {
      mediaKeys = [String(attachmentMedia.id)];
    }

    const eventTypeNorm = (ev.type as string) === 'message_create' ? 'MessageCreate' : (ev.type as string || 'MessageCreate');
    const senderUsername = senderId ? users?.[senderId]?.screen_name : undefined;

    results.push({
      event_id: eventId,
      dm_conversation_id: convId ?? '',
      sender_id: senderId ?? '',
      sender_username: senderUsername,
      participant_id: senderId,
      event_type: eventTypeNorm,
      text: text ?? null,
      media_keys: mediaKeys,
      raw: data, // store the whole data object as raw
      created_at: createdTimestamp
        ? new Date(Number(createdTimestamp)).toISOString()
        : new Date().toISOString(),
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main processor
// ---------------------------------------------------------------------------

/**
 * Normalize a webhook payload into an array of DmEvents.
 * Tolerates all known X API shapes (data.payload, X Activity, legacy).
 */
export function normalizePayload(payload: unknown): DmEvent[] {
  if (!payload || typeof payload !== 'object') return [];

  const obj = payload as Record<string, unknown>;

  // 1. Try data.payload shape (production — most common)
  const dataPayload = tryParseDataPayloadEnvelope(obj);
  if (dataPayload.length > 0) return dataPayload;

  // 2. Try X Activity envelope (dm_event)
  const single = tryParseXActivityEnvelope(obj);
  if (single) return [single];

  // 3. Try legacy Account Activity envelope (direct_message_events at root)
  const legacy = tryParseLegacyEnvelope(obj);
  if (legacy.length > 0) return legacy;

  // 4. Unknown shape — log and return empty
  console.warn('[EventProcessor] Unknown webhook payload shape:', JSON.stringify(payload).slice(0, 500));
  return [];
}

/**
 * Process a single DmEvent: dedupe, filter bot echoes, persist to DB.
 *
 * Returns true if the event was processed (new, non-bot), false if skipped.
 * This is safe to call from both webhook and poller paths.
 */
export async function processEvent(
  event: DmEvent,
  receivedVia: 'webhook' | 'poll',
): Promise<boolean> {
  const cfg = getConfig();

  // 1. Filter own echoes (§5.10)
  if (event.sender_id === cfg.X_BOT_USER_ID) {
    return false;
  }

  // 2. Dedupe by event_id (§5.2)
  const exists = await eventExists(event.event_id);
  if (exists) {
    return false;
  }

  // 3. Insert into dm_events_log
  await insertDmEvent({
    event_id: event.event_id,
    dm_conversation_id: event.dm_conversation_id,
    sender_id: event.sender_id,
    event_type: event.event_type,
    text: event.text,
    media_keys: event.media_keys,
    raw: event.raw,
    received_via: receivedVia,
    created_at: new Date(event.created_at).toISOString().slice(0, 19).replace('T', ' '),
  });

  // 4. Update last-seen tracking
  await kvSet(KV_KEYS.LAST_SEEN_EVENT_ID, event.event_id);
  if (receivedVia === 'webhook') {
    await kvSet(KV_KEYS.LAST_WEBHOOK_EVENT_AT, Date.now().toString());
  }

  // 5. Reply. A photo becomes a one-time claim link into the studio, where the
  // account, the PupCoin reservation and the view approval all still apply.
  // Anything else keeps the M3 echo — TODO(M5): replace with real refinement.
  //
  // Deliberately not awaited: a slow mint must not hold the webhook open, since
  // X retries a delivery that does not return promptly and we would process the
  // same DM twice.
  if (event.event_type === 'MessageCreate') {
    void (async () => {
      const claimText = await claimReplyForPhoto({
        mediaKeys: event.media_keys,
        sourceRef: event.dm_conversation_id || null,
      }).catch((err) => {
        console.error(`[EventProcessor] Photo claim failed: ${(err as Error).message}`);
        return null;
      });

      // For data.payload shape events, always reply via participantId (sender)
      // since the derived conversation id may not be accepted by the API.
      const replyText =
        claimText ||
        (event.text ? `Got it! 🐾 (echo: ${event.text.slice(0, 100)})` : 'Got it! 🐾');
      const dmOpts: { conversationId?: string; participantId?: string; text: string } =
        event.participant_id
          ? { participantId: event.participant_id, text: replyText }
          : event.dm_conversation_id
            ? { conversationId: event.dm_conversation_id, text: replyText }
            : { participantId: event.sender_id, text: replyText };
      await sendDm(dmOpts).catch((err) => {
        console.error(`[EventProcessor] Reply failed: ${(err as Error).message}`);
      });
    })();
  }

  return true;
}

/**
 * Process a raw webhook payload: normalize, dedupe, filter, persist.
 * Returns an array of successfully processed event_ids.
 */
export async function processWebhookPayload(
  payload: unknown,
  receivedVia: 'webhook' | 'poll',
): Promise<string[]> {
  const events = normalizePayload(payload);
  const processed: string[] = [];

  for (const event of events) {
    const ok = await processEvent(event, receivedVia);
    if (ok) {
      processed.push(event.event_id);
      console.log(`[EventProcessor] Processed ${event.event_id} (${event.event_type}) via ${receivedVia}`);
    }
  }

  return processed;
}