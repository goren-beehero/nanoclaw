import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-wirings' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-wirings';

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getDestinationByTarget } from '../../modules/agent-to-agent/db/agent-destinations.js';
import { dispatch } from '../dispatch.js';
import './wirings.js';

function now(): string {
  return new Date().toISOString();
}

describe('wirings CLI create', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    runMigrations(initTestDb());
    createAgentGroup({ id: 'ag-1', name: 'Bobi', folder: 'bobi', agent_provider: null, created_at: now() });
    createMessagingGroup({
      id: 'mg-new-channel',
      channel_type: 'slack',
      platform_id: 'slack:CNEW',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('atomically creates the outbound destination for a nameless discovered channel', async () => {
    const response = await dispatch(
      {
        id: 'req-create-wiring',
        command: 'wirings-create',
        args: {
          messaging_group_id: 'mg-new-channel',
          agent_group_id: 'ag-1',
          engage_mode: 'mention-sticky',
          sender_scope: 'all',
          ignored_message_policy: 'accumulate',
          session_mode: 'per-thread',
        },
      },
      { caller: 'host' },
    );

    expect(response.ok).toBe(true);
    const destination = getDestinationByTarget('ag-1', 'channel', 'mg-new-channel');
    expect(destination).toBeDefined();
    expect(destination?.local_name).toMatch(/^slack-/);
  });
});
