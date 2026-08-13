import { getChannelAdapterExact } from '../../channels/channel-registry.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import type { ChannelResourceListing } from '../../channels/adapter.js';
import { register } from '../registry.js';

function parseNoArgs(raw: Record<string, unknown>): Record<string, never> {
  const callerSuppliedRoute = ['channel', 'channel_id', 'channel-id', 'platform_id', 'platform-id'].find(
    (key) => raw[key] !== undefined,
  );
  if (callerSuppliedRoute) {
    throw new Error('Channel selection is not accepted; resources are derived from the active session.');
  }
  return {};
}

function formatListing(data: ChannelResourceListing): string {
  const lines = [`Current channel${data.channelName ? `: #${data.channelName}` : ''}`];
  if (data.resources.length === 0) lines.push('No visible channel resources.');
  for (const resource of data.resources) {
    const parent = resource.parentTitle ? ` [folder: ${resource.parentTitle}]` : '';
    const url = resource.url ? ` ${resource.url}` : '';
    lines.push(`- ${resource.kind}: ${resource.title}${parent}${url}`);
  }
  for (const item of data.warnings ?? []) lines.push(`Warning: ${item}`);
  return lines.join('\n');
}

register({
  name: 'channel-resources-list',
  description: 'List read-only folders, bookmarks, and files visible in the messaging channel of the active session.',
  resource: 'channel-resources',
  access: 'open',
  parseArgs: parseNoArgs,
  async handler(_args, ctx) {
    if (ctx.caller !== 'agent') throw new Error('Current-channel resources require an active agent session.');
    const group = getMessagingGroup(ctx.messagingGroupId);
    if (!group) throw new Error('Current messaging group was not found.');
    const adapter = getChannelAdapterExact(group.instance ?? group.channel_type);
    if (!adapter) throw new Error(`Channel adapter is offline: ${group.instance ?? group.channel_type}`);
    if (!adapter.listResources) {
      throw new Error(`Channel resources are not supported for ${group.channel_type}.`);
    }
    return adapter.listResources(group.platform_id);
  },
  formatHuman: formatListing,
});
