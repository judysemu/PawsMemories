/**
 * Tests for eventProcessor — normalization, dedupe, bot-echo filtering.
 *
 * Spec: X_DM_REFINEMENT_SPEC.md §5.2, §5.7
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizePayload, processEvent, type DmEvent, flushPendingReplies } from '../src/eventProcessor.js';

// Mock the db module
vi.mock('../src/db.js', () => ({
  eventExists: vi.fn(),
  insertDmEvent: vi.fn(),
  kvSet: vi.fn(),
  KV_KEYS: {
    LAST_SEEN_EVENT_ID: 'last_seen_event_id',
    LAST_WEBHOOK_EVENT_AT: 'last_webhook_event_at',
  },
}));

// Mock dmSender so echo replies don't fire HTTP calls
vi.mock('../src/dmSender.js', () => ({
  sendDm: vi.fn(() => Promise.resolve('mocked-event-id')),
}));

import { eventExists, insertDmEvent, kvSet } from '../src/db.js';
import { sendDm } from '../src/dmSender.js';

// Mock the config
vi.mock('../src/config.js', () => ({
  getConfig: vi.fn(() => ({
    X_BOT_USER_ID: 'bot-user-12345',
  })),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const xActivityPayload = {
  dm_event: {
    id: 'evt-001',
    text: 'Can you make my cat look like a dragon?',
    event_type: 'MessageCreate',
    dm_conversation_id: 'conv-001',
    sender_id: 'user-999',
    created_at: '2026-07-06T12:00:00Z',
    attachments: {
      media_keys: ['media_3_12345'],
    },
  },
  users: {
    'user-999': { username: 'catfan42' },
  },
};

const xActivityPayloadNoMedia = {
  dm_event: {
    id: 'evt-002',
    text: 'Hello',
    event_type: 'MessageCreate',
    dm_conversation_id: 'conv-002',
    sender_id: 'user-888',
    created_at: '2026-07-06T12:01:00Z',
  },
  users: {
    'user-888': { username: 'testuser' },
  },
};

const legacyPayload = {
  direct_message_events: [
    {
      id: 'legacy-evt-001',
      created_timestamp: '1720000000000',
      type: 'message_create',
      message_create: {
        sender_id: 'user-777',
        target: { recipient_id: 'bot-user-12345' },
        message_data: {
          text: 'Make it more metallic',
          attachment: {
            media: { id_str: 'media_4_67890', media_url: 'https://pbs.twimg.com/media/xxx.jpg' },
          },
        },
      },
    },
    {
      id: 'legacy-evt-002',
      created_timestamp: '1720000001000',
      type: 'message_create',
      message_create: {
        sender_id: 'user-666',
        target: { recipient_id: 'bot-user-12345' },
        message_data: {
          text: 'Just a text message',
        },
      },
    },
  ],
  users: {
    'user-777': { screen_name: 'artist3d' },
    'user-666': { screen_name: 'petlover' },
  },
};

const botEchoPayload = {
  dm_event: {
    id: 'evt-bot-echo',
    text: 'Working on it!',
    event_type: 'MessageCreate',
    dm_conversation_id: 'conv-001',
    sender_id: 'bot-user-12345',
    created_at: '2026-07-06T12:05:00Z',
  },
};

const participantsJoinPayload = {
  dm_event: {
    id: 'evt-join',
    event_type: 'ParticipantsJoin',
    dm_conversation_id: 'conv-001',
    sender_id: 'user-999',
    created_at: '2026-07-06T12:00:00Z',
  },
};

// ---------------------------------------------------------------------------
// normalizePayload tests
// ---------------------------------------------------------------------------

describe('normalizePayload', () => {
  it('should normalize X Activity API envelope (dm_event)', () => {
    const events = normalizePayload(xActivityPayload);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_id: 'evt-001',
      dm_conversation_id: 'conv-001',
      sender_id: 'user-999',
      sender_username: 'catfan42',
      event_type: 'MessageCreate',
      text: 'Can you make my cat look like a dragon?',
      media_keys: ['media_3_12345'],
    });
    expect(events[0].raw).toEqual(xActivityPayload);
    expect(events[0].created_at).toBe('2026-07-06T12:00:00Z');
  });

  it('should normalize X Activity payload without media', () => {
    const events = normalizePayload(xActivityPayloadNoMedia);
    expect(events).toHaveLength(1);
    expect(events[0].event_id).toBe('evt-002');
    expect(events[0].media_keys).toBeNull();
    expect(events[0].text).toBe('Hello');
  });

  it('should normalize legacy Account Activity envelope (direct_message_events)', () => {
    const events = normalizePayload(legacyPayload);
    expect(events).toHaveLength(2);

    // First event
    expect(events[0]).toMatchObject({
      event_id: 'legacy-evt-001',
      sender_id: 'user-777',
      sender_username: 'artist3d',
      event_type: 'MessageCreate',
      text: 'Make it more metallic',
      media_keys: ['media_4_67890'],
    });

    // Second event (no media)
    expect(events[1]).toMatchObject({
      event_id: 'legacy-evt-002',
      sender_id: 'user-666',
      sender_username: 'petlover',
      event_type: 'MessageCreate',
      text: 'Just a text message',
      media_keys: null,
    });
  });

  it('should normalize ParticipantsJoin event type', () => {
    const events = normalizePayload(participantsJoinPayload);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('ParticipantsJoin');
    expect(events[0].text).toBeNull();
  });

  it('should return empty array for null/undefined payload', () => {
    expect(normalizePayload(null)).toEqual([]);
    expect(normalizePayload(undefined)).toEqual([]);
    expect(normalizePayload('string')).toEqual([]);
    expect(normalizePayload(42)).toEqual([]);
  });

  it('should return empty array for unknown payload shape', () => {
    const unknown = { some_unknown_field: 'value' };
    expect(normalizePayload(unknown)).toEqual([]);
  });

  it('should prefer X Activity shape over legacy when both present', () => {
    // If both dm_event and direct_message_events are present, dm_event wins
    const mixed = {
      ...xActivityPayload,
      direct_message_events: [
        {
          id: 'legacy',
          type: 'message_create',
          message_create: {
            sender_id: 'user-xxx',
            message_data: { text: 'ignored' },
          },
        },
      ],
    };
    const events = normalizePayload(mixed);
    expect(events).toHaveLength(1);
    expect(events[0].event_id).toBe('evt-001');
  });

  it('should handle legacy events without dm_conversation_id', () => {
    const legacyNoConv = {
      direct_message_events: [
        {
          id: 'no-conv',
          created_timestamp: '1720000000000',
          type: 'message_create',
          message_create: {
            sender_id: 'user-555',
            target: { recipient_id: 'bot-123' },
            message_data: { text: 'hello' },
          },
        },
      ],
    };
    const events = normalizePayload(legacyNoConv);
    expect(events).toHaveLength(1);
    // dm_conversation_id should be empty string (not undefined)
    expect(events[0].dm_conversation_id).toBe('');
  });
});

// ---------------------------------------------------------------------------
// processEvent tests (dedupe, bot-echo filtering)
// ---------------------------------------------------------------------------

describe('processEvent', () => {
  const mockEvent: DmEvent = {
    event_id: 'evt-process-001',
    dm_conversation_id: 'conv-001',
    sender_id: 'user-999',
    event_type: 'MessageCreate',
    text: 'Test message',
    media_keys: null,
    raw: { test: true },
    created_at: '2026-07-06T12:00:00Z',
  };

  const botEcho: DmEvent = {
    event_id: 'evt-bot-echo',
    dm_conversation_id: 'conv-001',
    sender_id: 'bot-user-12345',
    event_type: 'MessageCreate',
    text: 'Echo from bot',
    media_keys: null,
    raw: { test: true },
    created_at: '2026-07-06T12:05:00Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should process a new event (not duplicate, not bot echo)', async () => {
    vi.mocked(eventExists).mockResolvedValue(false);
    vi.mocked(insertDmEvent).mockResolvedValue(true);

    const result = await processEvent(mockEvent, 'webhook');

    expect(result).toBe(true);
    expect(eventExists).toHaveBeenCalledWith('evt-process-001');
    expect(insertDmEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: 'evt-process-001',
        received_via: 'webhook',
      }),
    );
    expect(kvSet).toHaveBeenCalledWith('last_webhook_event_at', expect.any(String));
  });

  it('should trigger echo reply for new MessageCreate events', async () => {
    vi.mocked(eventExists).mockResolvedValue(false);
    vi.mocked(insertDmEvent).mockResolvedValue(true);
    vi.mocked(sendDm).mockResolvedValue('mocked-event-id');

    const result = await processEvent(mockEvent, 'webhook');

    expect(result).toBe(true);
    expect(sendDm).toHaveBeenCalledWith({
      conversationId: 'conv-001',
      text: expect.stringContaining('Got it!'),
    });
  });

  it('should NOT trigger echo reply for bot echoes', async () => {
    const result = await processEvent(botEcho, 'webhook');

    expect(result).toBe(false);
    expect(sendDm).not.toHaveBeenCalled();
  });

  it('should NOT trigger echo reply for duplicate events', async () => {
    vi.mocked(eventExists).mockResolvedValue(true);

    const result = await processEvent(mockEvent, 'webhook');

    expect(result).toBe(false);
    expect(sendDm).not.toHaveBeenCalled();
  });

  it('should NOT trigger echo reply for ParticipantsJoin events', async () => {
    vi.mocked(eventExists).mockResolvedValue(false);
    vi.mocked(insertDmEvent).mockResolvedValue(true);

    const joinEvent: DmEvent = {
      event_id: 'evt-join',
      dm_conversation_id: 'conv-001',
      sender_id: 'user-999',
      event_type: 'ParticipantsJoin',
      text: null,
      media_keys: null,
      raw: {},
      created_at: '2026-07-06T12:00:00Z',
    };

    const result = await processEvent(joinEvent, 'webhook');
    expect(result).toBe(true);
    expect(sendDm).not.toHaveBeenCalled();
  });

  it('should skip bot echoes (sender_id === X_BOT_USER_ID)', async () => {
    const result = await processEvent(botEcho, 'webhook');

    expect(result).toBe(false);
    // Should NOT have checked DB or inserted
    expect(eventExists).not.toHaveBeenCalled();
    expect(insertDmEvent).not.toHaveBeenCalled();
  });

  it('should skip duplicate events (already in dm_events_log)', async () => {
    vi.mocked(eventExists).mockResolvedValue(true);

    const result = await processEvent(mockEvent, 'poll');

    expect(result).toBe(false);
    expect(eventExists).toHaveBeenCalledWith('evt-process-001');
    expect(insertDmEvent).not.toHaveBeenCalled();
  });

  it('should record received_via=poll for poller events', async () => {
    vi.mocked(eventExists).mockResolvedValue(false);
    vi.mocked(insertDmEvent).mockResolvedValue(true);

    await processEvent(mockEvent, 'poll');

    expect(insertDmEvent).toHaveBeenCalledWith(
      expect.objectContaining({ received_via: 'poll' }),
    );
    // Should NOT update last_webhook_event_at for poll events
    // (it only updates for received_via='webhook')
    expect(kvSet).toHaveBeenCalledWith('last_seen_event_id', 'evt-process-001');
  });

  it('should handle participants join events', async () => {
    vi.mocked(eventExists).mockResolvedValue(false);
    vi.mocked(insertDmEvent).mockResolvedValue(true);

    const joinEvent: DmEvent = {
      event_id: 'evt-join-001',
      dm_conversation_id: 'conv-001',
      sender_id: 'user-999',
      event_type: 'ParticipantsJoin',
      text: null,
      media_keys: null,
      raw: {},
      created_at: '2026-07-06T12:00:00Z',
    };

    const result = await processEvent(joinEvent, 'webhook');
    expect(result).toBe(true);
    expect(insertDmEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'ParticipantsJoin',
        text: null,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Data payload envelope (production shape) — normalizePayload
// ---------------------------------------------------------------------------

const dataPayloadReal = {
  data: {
    event_uuid: 'ev-uuid-001',
    filter: { user_id: 'bot-user-12345' },
    event_type: 'dm.received',
    tag: 'pawsome3d-dm-in',
    payload: {
      direct_message_events: [
        {
          type: 'message_create',
          id: '2074317363693203632',
          created_timestamp: '1783390773146',
          message_create: {
            target: { recipient_id: 'bot-user-12345' },
            sender_id: 'user-999',
            message_data: {
              text: 'Make my cat look like a dragon!',
              entities: {},
            },
          },
        },
      ],
      users: {
        'user-999': { screen_name: 'catfan42' },
        'bot-user-12345': { screen_name: 'pawsome3d' },
      },
    },
  },
};

const dataPayloadRealWithMedia = {
  data: {
    event_uuid: 'ev-uuid-002',
    filter: { user_id: 'bot-user-12345' },
    event_type: 'dm.received',
    tag: 'pawsome3d-dm-in',
    payload: {
      direct_message_events: [
        {
          type: 'message_create',
          id: '2074317363693203633',
          created_timestamp: '1783390774146',
          message_create: {
            target: { recipient_id: 'bot-user-12345' },
            sender_id: 'user-888',
            message_data: {
              text: 'Make it more shiny!',
              attachment: {
                media: {
                  id_str: 'media_12345',
                  media_url_https: 'https://pbs.twimg.com/media/xxx.jpg',
                  type: 'photo',
                },
              },
            },
          },
        },
      ],
      users: {
        'user-888': { screen_name: 'petlover' },
      },
    },
  },
};

const dataPayloadBotEcho = {
  data: {
    event_uuid: 'ev-uuid-003',
    filter: { user_id: 'bot-user-12345' },
    event_type: 'dm.received',
    tag: 'pawsome3d-dm-in',
    payload: {
      direct_message_events: [
        {
          type: 'message_create',
          id: '2074317363693204444',
          created_timestamp: '1783390775146',
          message_create: {
            target: { recipient_id: 'user-999' },
            sender_id: 'bot-user-12345',
            message_data: {
              text: 'Got it! 🐾 (echo: Make my cat look like a dragon!)',
            },
          },
        },
      ],
    },
  },
};

describe('normalizePayload — data.payload production shape', () => {
  it('should parse the real production shape', () => {
    const events = normalizePayload(dataPayloadReal);
    expect(events).toHaveLength(1);
    expect(events[0].event_id).toBe('2074317363693203632');
    expect(events[0].sender_id).toBe('user-999');
    expect(events[0].sender_username).toBe('catfan42');
    expect(events[0].event_type).toBe('MessageCreate');
    expect(events[0].text).toBe('Make my cat look like a dragon!');
    expect(events[0].created_at).toBe(new Date(1783390773146).toISOString());
  });

  it('should derive dm_conversation_id from sender+recipient numeric sort', () => {
    const events = normalizePayload(dataPayloadReal);
    expect(events[0].dm_conversation_id).toBe('bot-user-12345-user-999');
  });

  it('should expose participant_id for A16 fallback echo reply', () => {
    const events = normalizePayload(dataPayloadReal);
    expect(events[0].participant_id).toBe('user-999');
  });

  it('should extract media_url_https from attachment.media', () => {
    const events = normalizePayload(dataPayloadRealWithMedia);
    expect(events).toHaveLength(1);
    expect(events[0].media_keys).toEqual(['https://pbs.twimg.com/media/xxx.jpg']);
  });

  it('should return empty array for payload without data event_type dm.*', () => {
    const noDm = { data: { event_type: 'tweet.create', payload: { direct_message_events: [] } } };
    expect(normalizePayload(noDm)).toEqual([]);
  });

  it('should return empty array for payload without direct_message_events', () => {
    const noDme = { data: { event_type: 'dm.received', payload: {} } };
    expect(normalizePayload(noDme)).toEqual([]);
  });

  it('should not interfere with existing X Activity shape parsing', () => {
    const xActivity = {
      dm_event: {
        id: 'evt-xact',
        text: 'X Activity DM',
        event_type: 'MessageCreate',
        dm_conversation_id: 'conv-001',
        sender_id: 'user-999',
        created_at: '2026-07-06T12:00:00Z',
      },
    };
    const events = normalizePayload(xActivity);
    expect(events).toHaveLength(1);
    expect(events[0].event_id).toBe('evt-xact');
  });

  it('should not interfere with existing legacy envelope parsing', () => {
    const legacy = {
      direct_message_events: [
        {
          id: 'legacy-001',
          type: 'message_create',
          message_create: {
            sender_id: 'user-777',
            target: { recipient_id: 'bot-123' },
            message_data: { text: 'legacy dm' },
          },
        },
      ],
    };
    const events = normalizePayload(legacy);
    expect(events).toHaveLength(1);
    expect(events[0].event_id).toBe('legacy-001');
  });
});

// ---------------------------------------------------------------------------
// Data payload envelope — processEvent (echo reply, bot filter, dedupe)
// ---------------------------------------------------------------------------

describe('processEvent — data.payload production shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(eventExists).mockReset();
    vi.mocked(insertDmEvent).mockReset();
    vi.mocked(sendDm).mockReset();
  });

  it('should trigger echo reply via participant_id for data.payload events', async () => {
    vi.mocked(eventExists).mockResolvedValue(false);
    vi.mocked(insertDmEvent).mockResolvedValue(true);
    vi.mocked(sendDm).mockResolvedValue('mocked-event-id');

    const events = normalizePayload(dataPayloadReal);
    const result = await processEvent(events[0], 'webhook');

    expect(result).toBe(true);
    expect(sendDm).toHaveBeenCalledWith({
      participantId: 'user-999',
      text: expect.stringContaining('Got it!'),
    });
  });

  it('should NOT trigger echo for bot echo events (sender === X_BOT_USER_ID)', async () => {
    const events = normalizePayload(dataPayloadBotEcho);

    const result = await processEvent(events[0], 'webhook');

    expect(result).toBe(false);
    expect(sendDm).not.toHaveBeenCalled();
  });

  it('should dedupe by event_id (entry.id)', async () => {
    vi.mocked(eventExists).mockResolvedValue(true);

    const events = normalizePayload(dataPayloadReal);
    const result = await processEvent(events[0], 'webhook');

    expect(result).toBe(false);
    expect(insertDmEvent).not.toHaveBeenCalled();
    expect(sendDm).not.toHaveBeenCalled();
  });

  it('should process new event and reply when both subscriptions already exist', async () => {
    vi.mocked(eventExists).mockResolvedValue(false);
    vi.mocked(insertDmEvent).mockResolvedValue(true);
    vi.mocked(sendDm).mockResolvedValue('mocked-event-id');

    const events = normalizePayload(dataPayloadRealWithMedia);
    const result = await processEvent(events[0], 'webhook');
    // A photo reply is dispatched off the webhook response on purpose, so the
    // send has not necessarily happened by the time processEvent returns.
    await flushPendingReplies();

    expect(result).toBe(true);
    expect(insertDmEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: '2074317363693203633',
        sender_id: 'user-888',
        text: 'Make it more shiny!',
      }),
    );
    expect(sendDm).toHaveBeenCalledWith({
      participantId: 'user-888',
      text: expect.stringContaining('Got it!'),
    });
  });
});