import type { ForwardedMessageContext } from './chat-sdk-bridge.js';

const MAX_FORWARDED_MESSAGES = 8;
const MAX_FORWARDED_TOTAL_TEXT_LENGTH = 40_000;

type SlackForwardAttachment = {
  is_msg_unfurl?: unknown;
  channel_id?: unknown;
  ts?: unknown;
  text?: unknown;
  fallback?: unknown;
  title?: unknown;
  title_link?: unknown;
  from_url?: unknown;
  original_url?: unknown;
  author_id?: unknown;
  author_name?: unknown;
  author_subname?: unknown;
  blocks?: unknown;
  message_blocks?: unknown;
};

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function collectBlockText(value: unknown, parts: string[], depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectBlockText(item, parts, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;

  const node = value as Record<string, unknown>;
  const type = stringValue(node.type);
  if (type === 'text') {
    const text = stringValue(node.text);
    if (text) parts.push(text);
  } else if (type === 'link') {
    const link = stringValue(node.text) ?? stringValue(node.url);
    if (link) parts.push(link);
  } else if (type === 'user') {
    const userId = stringValue(node.user_id);
    if (userId) parts.push(`<@${userId}>`);
  } else if (type === 'channel') {
    const channelId = stringValue(node.channel_id);
    if (channelId) parts.push(`<#${channelId}>`);
  }

  collectBlockText(node.elements, parts, depth + 1);
  collectBlockText(node.blocks, parts, depth + 1);
  collectBlockText(node.message_blocks, parts, depth + 1);
  collectBlockText(node.message, parts, depth + 1);
}

function extractAttachmentText(attachment: SlackForwardAttachment): string | undefined {
  const direct = stringValue(attachment.text) ?? stringValue(attachment.fallback);
  if (direct) return direct;

  const blockParts: string[] = [];
  collectBlockText(attachment.blocks, blockParts);
  collectBlockText(attachment.message_blocks, blockParts);
  const blockText = blockParts.join(' ').replace(/\s+/g, ' ').trim();
  if (blockText) return blockText;

  return stringValue(attachment.title);
}

function isForwardedMessage(attachment: SlackForwardAttachment): boolean {
  if (attachment.is_msg_unfurl === true) return true;
  return Boolean(stringValue(attachment.channel_id) && stringValue(attachment.ts));
}

/**
 * Extract only Slack-forwarded message context from the raw event. The full
 * platform payload stays discarded by the bridge as before.
 */
export function extractSlackForwardedMessages(raw: Record<string, unknown>): ForwardedMessageContext[] {
  if (!Array.isArray(raw.attachments)) return [];

  const forwarded: ForwardedMessageContext[] = [];
  const seen = new Set<string>();
  let remainingTextLength = MAX_FORWARDED_TOTAL_TEXT_LENGTH;

  for (const candidate of raw.attachments) {
    if (!candidate || typeof candidate !== 'object') continue;
    const attachment = candidate as SlackForwardAttachment;
    if (!isForwardedMessage(attachment)) continue;

    const extractedText = extractAttachmentText(attachment);
    if (!extractedText || remainingTextLength <= 0) continue;
    const text = extractedText.slice(0, remainingTextLength);

    const sender =
      stringValue(attachment.author_name) ??
      stringValue(attachment.author_subname) ??
      stringValue(attachment.author_id);
    const sourceUrl =
      stringValue(attachment.title_link) ??
      stringValue(attachment.from_url) ??
      stringValue(attachment.original_url);
    const timestamp = stringValue(attachment.ts);
    const key = `${timestamp ?? ''}\n${sourceUrl ?? ''}\n${text}`;
    if (seen.has(key)) continue;
    seen.add(key);

    forwarded.push({ text, sender, sourceUrl, timestamp });
    remainingTextLength -= text.length;
    if (forwarded.length >= MAX_FORWARDED_MESSAGES) break;
  }

  return forwarded;
}
