/**
 * Slack channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Socket Mode opt-in: set SLACK_APP_TOKEN (xapp-…) to receive events over an
 * outbound WebSocket instead of an inbound HTTPS webhook.
 */
import { createSlackAdapter } from '@chat-adapter/slack';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';
import { extractSlackForwardedMessages } from './slack-forwarded-context.js';

registerChannelAdapter('slack', {
  factory: () => {
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN']);
    if (!env.SLACK_BOT_TOKEN) return null;
    // SLACK_APP_TOKEN (xapp-…) enables Socket Mode: events arrive over an
    // outbound WebSocket, so no public HTTPS endpoint is required. When set,
    // the signing secret is optional (Slack signs socket frames separately).
    const useSocketMode = Boolean(env.SLACK_APP_TOKEN);
    const slackAdapter = createSlackAdapter({
      botToken: env.SLACK_BOT_TOKEN,
      signingSecret: env.SLACK_SIGNING_SECRET,
      appToken: env.SLACK_APP_TOKEN,
      mode: useSocketMode ? 'socket' : 'webhook',
    });
    const bridge = createChatSdkBridge({
      adapter: slackAdapter,
      concurrency: 'concurrent',
      supportsThreads: true,
      extractForwardedContext: extractSlackForwardedMessages,
    });
    bridge.resolveChannelName = async (platformId: string) => {
      try {
        const info = await slackAdapter.fetchThread(platformId);
        return (info as { channelName?: string }).channelName ?? null;
      } catch {
        return null;
      }
    };
    bridge.resolveThreadRootUserId = async (_platformId: string, threadId: string) => {
      const page = await slackAdapter.fetchMessages(threadId, { limit: 1, direction: 'forward' });
      return page.messages[0]?.author.userId ?? null;
    };
    bridge.resolveThreadRootMetadata = async (_platformId: string, threadId: string) => {
      const page = await slackAdapter.fetchMessages(threadId, { limit: 1, direction: 'forward' });
      const root = page.messages[0];
      if (!root?.author.userId) return null;
      const rawText = (root.raw as { text?: unknown } | undefined)?.text;
      return { userId: root.author.userId, text: typeof rawText === 'string' ? rawText : (root.text ?? '') };
    };
    return bridge;
  },
});
