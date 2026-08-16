import fs from 'fs';

const DEFAULT_CONFIG_PATH = '/home/ec2-user/.config/nanoclaw/salesforce-network-attachments.json';
const ALLOWED_NETWORKS = new Set(['bobi-salesforce-private']);
const NETWORK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

interface AttachmentFile {
  version: 1;
  agentGroups: Record<string, string[]>;
}

export function loadContainerNetworkAttachments(
  agentGroupId: string,
  configPath = process.env.SALESFORCE_NETWORK_ATTACHMENTS_PATH || DEFAULT_CONFIG_PATH,
): string[] {
  if (!fs.existsSync(configPath)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error('Container network attachment config is unreadable or invalid JSON', { cause: error });
  }

  if (!isAttachmentFile(parsed)) {
    throw new Error('Container network attachment config has an invalid shape');
  }

  const requested = parsed.agentGroups[agentGroupId] ?? [];
  const unique = [...new Set(requested)];
  for (const network of unique) {
    if (!NETWORK_NAME.test(network) || !ALLOWED_NETWORKS.has(network)) {
      throw new Error('Container network attachment is not allowlisted');
    }
  }
  return unique;
}

export function containerNetworkArgs(networks: string[]): string[] {
  return networks.flatMap((network) => ['--network', network]);
}

function isAttachmentFile(value: unknown): value is AttachmentFile {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !record.agentGroups || typeof record.agentGroups !== 'object') return false;
  return Object.values(record.agentGroups as Record<string, unknown>).every(
    (entry) => Array.isArray(entry) && entry.every((network) => typeof network === 'string'),
  );
}
