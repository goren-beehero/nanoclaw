import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMessagingGroup = vi.fn();
const getChannelAdapterExact = vi.fn();

vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: (...args: unknown[]) => getMessagingGroup(...args),
}));

vi.mock('../../channels/channel-registry.js', () => ({
  getChannelAdapterExact: (...args: unknown[]) => getChannelAdapterExact(...args),
}));

import { lookup } from '../registry.js';
import type { CallerContext } from '../frame.js';
import './channel-resources.js';

const agentContext: CallerContext = {
  caller: 'agent',
  sessionId: 'session-1',
  agentGroupId: 'agent-1',
  messagingGroupId: 'mg-current',
};

describe('channel-resources CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMessagingGroup.mockReturnValue({
      id: 'mg-current',
      channel_type: 'slack',
      platform_id: 'slack:C012ABC',
      instance: 'slack',
    });
  });

  it('derives the exact channel from caller context', async () => {
    const listResources = vi.fn().mockResolvedValue({
      channelName: 'bobi-testing',
      resources: [{ id: 'F1', title: 'terms.csv', kind: 'file' }],
    });
    getChannelAdapterExact.mockReturnValue({ listResources });
    const command = lookup('channel-resources-list')!;

    const parsed = command.parseArgs({});
    const result = await command.handler(parsed, agentContext);

    expect(getMessagingGroup).toHaveBeenCalledWith('mg-current');
    expect(getChannelAdapterExact).toHaveBeenCalledWith('slack');
    expect(listResources).toHaveBeenCalledWith('slack:C012ABC');
    expect(result).toMatchObject({ channelName: 'bobi-testing' });
  });

  it('rejects arbitrary channel selection', () => {
    const command = lookup('channel-resources-list')!;
    expect(() => command.parseArgs({ channel_id: 'C-OTHER' })).toThrow('derived from the active session');
  });

  it('fails closed when the active adapter cannot list resources', async () => {
    getChannelAdapterExact.mockReturnValue({});
    const command = lookup('channel-resources-list')!;
    await expect(command.handler(command.parseArgs({}), agentContext)).rejects.toThrow(
      'Channel resources are not supported for slack',
    );
  });

  it('does not let a host caller invent current-channel context', async () => {
    const command = lookup('channel-resources-list')!;
    await expect(command.handler(command.parseArgs({}), { caller: 'host' })).rejects.toThrow('active agent session');
  });
});
