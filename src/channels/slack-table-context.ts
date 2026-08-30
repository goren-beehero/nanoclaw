const MAX_TABLES = 8;
const MAX_ROWS_PER_TABLE = 201;
const MAX_COLUMNS_PER_ROW = 20;
const MAX_TOTAL_TEXT_LENGTH = 40_000;

type SlackTableBlock = {
  type?: unknown;
  caption?: unknown;
  rows?: unknown;
};

function nonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function renderRichText(value: unknown, depth = 0): string {
  if (depth > 10 || value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((item) => renderRichText(item, depth + 1)).join('');
  if (typeof value !== 'object') return '';

  const node = value as Record<string, unknown>;
  const type = nonemptyString(node.type);
  if (type === 'text') return typeof node.text === 'string' ? node.text : '';
  if (type === 'link') {
    const text = nonemptyString(node.text);
    const url = nonemptyString(node.url);
    if (text && url && text !== url) return `${text} (${url})`;
    return text ?? url ?? '';
  }
  if (type === 'user') {
    const userId = nonemptyString(node.user_id);
    return userId ? `<@${userId}>` : '';
  }
  if (type === 'channel') {
    const channelId = nonemptyString(node.channel_id);
    return channelId ? `<#${channelId}>` : '';
  }
  if (type === 'broadcast') {
    const range = nonemptyString(node.range);
    return range ? `@${range}` : '';
  }
  if (type === 'usergroup') {
    const usergroupId = nonemptyString(node.usergroup_id);
    return usergroupId ? `<!subteam^${usergroupId}>` : '';
  }
  if (type === 'emoji') {
    const name = nonemptyString(node.name);
    return name ? `:${name}:` : '';
  }
  if (type === 'date') return nonemptyString(node.fallback) ?? '';

  if (!Array.isArray(node.elements)) return '';
  const separator = type === 'rich_text_list' ? ' / ' : '';
  return node.elements.map((element) => renderRichText(element, depth + 1)).join(separator);
}

function renderCell(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const cell = value as Record<string, unknown>;
  const type = nonemptyString(cell.type);

  if (type === 'raw_text') return typeof cell.text === 'string' ? cell.text : '';
  if (type === 'raw_number') {
    if (typeof cell.text === 'string') return cell.text;
    return typeof cell.value === 'number' && Number.isFinite(cell.value) ? String(cell.value) : '';
  }
  if (type === 'rich_text') {
    if (!Array.isArray(cell.elements)) return '';
    return cell.elements.map((element) => renderRichText(element)).join('\n');
  }
  return '';
}

function sanitizeCell(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(/\n/g, ' ↵ ').trim();
}

function renderTable(block: SlackTableBlock, index: number): string | undefined {
  if (!Array.isArray(block.rows)) return undefined;

  const rows = block.rows.slice(0, MAX_ROWS_PER_TABLE).flatMap((row) => {
    if (!Array.isArray(row) || row.length === 0) return [];
    return [
      row
        .slice(0, MAX_COLUMNS_PER_ROW)
        .map((cell) => sanitizeCell(renderCell(cell)))
        .join('\t'),
    ];
  });
  if (rows.length === 0) return undefined;

  const caption = nonemptyString(block.caption);
  const type = block.type === 'data_table' ? 'data table' : 'table';
  const heading = caption ? `Slack ${type}: ${caption}` : `Slack ${type} ${index + 1}`;
  return `${heading}\n\`\`\`tsv\n${rows.join('\n')}\n\`\`\``;
}

function collectCandidateBlocks(raw: Record<string, unknown>): unknown[] {
  const candidates: unknown[] = [];
  if (Array.isArray(raw.blocks)) candidates.push(...raw.blocks);
  if (Array.isArray(raw.attachments)) {
    for (const attachment of raw.attachments) {
      if (!attachment || typeof attachment !== 'object') continue;
      const record = attachment as Record<string, unknown>;
      // Forwarded-message attachments are rendered separately as quoted
      // context. Promoting their tables into the sender's active message text
      // would lose provenance and duplicate the forwarded content.
      if (
        record.is_msg_unfurl === true ||
        (nonemptyString(record.channel_id) !== undefined && nonemptyString(record.ts) !== undefined)
      ) {
        continue;
      }
      const blocks = record.blocks;
      if (Array.isArray(blocks)) candidates.push(...blocks);
    }
  }
  return candidates;
}

/**
 * Convert Slack-native table blocks into bounded TSV text before the Chat SDK
 * bridge discards the raw event. The model receives ordinary user-visible
 * message text; the platform payload and unrelated blocks remain private.
 */
export function extractSlackTableText(raw: Record<string, unknown>): string[] {
  return renderCandidateTables(collectCandidateBlocks(raw));
}

/** Render table blocks already isolated from a containing Slack structure. */
export function extractSlackTableTextFromBlocks(blocks: unknown): string[] {
  const candidates: unknown[] = [];
  collectNestedTableBlocks(blocks, candidates);
  return renderCandidateTables(candidates);
}

function collectNestedTableBlocks(value: unknown, candidates: unknown[], depth = 0): void {
  if (depth > 10 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectNestedTableBlocks(item, candidates, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;

  const node = value as Record<string, unknown>;
  if (node.type === 'table' || node.type === 'data_table') {
    candidates.push(node);
    return;
  }

  collectNestedTableBlocks(node.blocks, candidates, depth + 1);
  collectNestedTableBlocks(node.message_blocks, candidates, depth + 1);
  collectNestedTableBlocks(node.message, candidates, depth + 1);
}

function renderCandidateTables(candidates: unknown[]): string[] {
  const tables: string[] = [];
  const seen = new Set<string>();
  let remaining = MAX_TOTAL_TEXT_LENGTH;

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const block = candidate as SlackTableBlock;
    if (block.type !== 'table' && block.type !== 'data_table') continue;

    const rendered = renderTable(block, tables.length);
    if (!rendered || remaining <= 0) continue;
    const bodyStart = rendered.indexOf('\n');
    const dedupeKey = `${block.type}\n${nonemptyString(block.caption) ?? ''}\n${rendered.slice(bodyStart + 1)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const closingFence = '\n```';
    const bounded =
      rendered.length <= remaining
        ? rendered
        : `${rendered.slice(0, Math.max(0, remaining - closingFence.length))}${closingFence}`;
    tables.push(bounded);
    remaining -= bounded.length;
    if (tables.length >= MAX_TABLES) break;
  }

  return tables;
}
