import { describe, expect, it, vi } from 'vitest';

import type { ChannelSetup, InboundMessage } from './adapter.js';
import { appendMediaWithheldNote, runAuthorizedMediaDownload } from './whatsapp.js';

const inbound: InboundMessage = {
  id: 'wa-media-1',
  kind: 'chat',
  isMention: true,
  isGroup: false,
  content: {
    text: '',
    sender: '15551234567@s.whatsapp.net',
    senderName: 'Unknown sender',
  },
  timestamp: new Date(0).toISOString(),
};

function setup(authorize?: ChannelSetup['authorizeInboundMedia']): ChannelSetup {
  return {
    ...(authorize && { authorizeInboundMedia: authorize }),
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  };
}

describe('WhatsApp inbound media admission', () => {
  it.each([
    ['legacy host with no admission hook', setup()],
    ['host denial', setup(async () => false)],
  ])('fails closed before invoking the downloader: %s', async (_label, hostSetup) => {
    const download = vi.fn(async () => ({ bytes: 'attacker-controlled' }));

    await expect(
      runAuthorizedMediaDownload(hostSetup, '15551234567@s.whatsapp.net', inbound, download),
    ).resolves.toEqual({
      authorized: false,
    });
    expect(download).not.toHaveBeenCalled();
  });

  it('invokes the downloader exactly once after host authorization', async () => {
    const authorize = vi.fn(async () => true);
    const download = vi.fn(async () => ({ bytes: 'trusted' }));

    await expect(
      runAuthorizedMediaDownload(setup(authorize), '15551234567@s.whatsapp.net', inbound, download),
    ).resolves.toEqual({ authorized: true, value: { bytes: 'trusted' } });
    expect(authorize).toHaveBeenCalledWith('15551234567@s.whatsapp.net', null, inbound);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('leaves a safe resend instruction for an attachment withheld during approval', () => {
    expect(appendMediaWithheldNote('', ['image'])).toBe(
      '[image withheld until sender authorization; please resend after approval]',
    );
    expect(appendMediaWithheldNote('caption', ['image', 'document'])).toBe(
      'caption\n[image, document withheld until sender authorization; please resend after approval]',
    );
  });
});
