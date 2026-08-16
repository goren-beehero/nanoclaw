import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { containerNetworkArgs, loadContainerNetworkAttachments } from './container-network-attachments.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function config(value: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'network-attachments-'));
  dirs.push(dir);
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

describe('loadContainerNetworkAttachments', () => {
  it('returns no attachments when the operator file is absent', () => {
    expect(loadContainerNetworkAttachments('group', '/definitely/missing')).toEqual([]);
  });

  it('returns only the exact allowlisted network for the selected group', () => {
    const file = config({ version: 1, agentGroups: { bobi: ['bobi-salesforce-private'] } });
    expect(loadContainerNetworkAttachments('bobi', file)).toEqual(['bobi-salesforce-private']);
    expect(loadContainerNetworkAttachments('other', file)).toEqual([]);
  });

  it('fails closed for an unapproved network or malformed file', () => {
    const unapproved = config({ version: 1, agentGroups: { bobi: ['bridge'] } });
    expect(() => loadContainerNetworkAttachments('bobi', unapproved)).toThrow('not allowlisted');
    const malformed = config({ version: 2, agentGroups: [] });
    expect(() => loadContainerNetworkAttachments('bobi', malformed)).toThrow('invalid shape');
  });
});

describe('containerNetworkArgs', () => {
  it('emits explicit Docker network arguments', () => {
    expect(containerNetworkArgs(['bobi-salesforce-private'])).toEqual(['--network', 'bobi-salesforce-private']);
  });
});
