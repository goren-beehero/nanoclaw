import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './db/connection.js';
import { appendSlackTaskDeliveryRequirement } from './poll-loop.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function seedDestination(name: string, channelType: string, platformId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, name, channelType, platformId);
}

describe('Slack-origin task delivery requirement', () => {
  it('requires text delivery through send_message to the captured Slack destination', () => {
    seedDestination('bobi-bi', 'slack', 'C-FINANCE');

    const prompt = appendSlackTaskDeliveryRequirement('<task>Instructions: Build the report</task>', [
      { kind: 'task', channel_type: 'slack', platform_id: 'C-FINANCE' },
    ]);

    expect(prompt).toContain('DELIVERY REQUIREMENT (mandatory)');
    expect(prompt).toContain('`mcp__nanoclaw__send_message` exactly once');
    expect(prompt).toContain('`to="bobi-bi"`');
    expect(prompt).toContain('originating Slack thread');
  });

  it('allows send_file to satisfy delivery without an extra text message', () => {
    seedDestination('bobi-bi', 'slack', 'C-FINANCE');

    const prompt = appendSlackTaskDeliveryRequirement('<task>Send the generated HTML file</task>', [
      { kind: 'task', channel_type: 'slack', platform_id: 'C-FINANCE' },
    ]);

    expect(prompt).toContain('`mcp__nanoclaw__send_file`');
    expect(prompt).toContain('That file delivery satisfies this requirement');
    expect(prompt).toContain('do not also call send_message unless the task explicitly requests');
    expect(prompt).toContain('do not add a duplicate acknowledgement');
  });

  it('does not change an interactive Slack message', () => {
    seedDestination('bobi-bi', 'slack', 'C-FINANCE');
    const original = '<message>What is the status?</message>';

    expect(
      appendSlackTaskDeliveryRequirement(original, [
        { kind: 'chat', channel_type: 'slack', platform_id: 'C-FINANCE' },
      ]),
    ).toBe(original);
  });

  it('does not change a non-Slack task', () => {
    seedDestination('ops-whatsapp', 'whatsapp', 'WA-OPS');
    const original = '<task>Instructions: Build the report</task>';

    expect(
      appendSlackTaskDeliveryRequirement(original, [
        { kind: 'task', channel_type: 'whatsapp', platform_id: 'WA-OPS' },
      ]),
    ).toBe(original);
  });

  it('does not inject an unusable destination for an unrouted Slack task', () => {
    const original = '<task>Instructions: Build the report</task>';

    expect(
      appendSlackTaskDeliveryRequirement(original, [
        { kind: 'task', channel_type: 'slack', platform_id: 'C-UNKNOWN' },
      ]),
    ).toBe(original);
  });
});
