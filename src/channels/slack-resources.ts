import type { ChannelResource, ChannelResourceListing } from './adapter.js';

type FetchLike = typeof fetch;

interface SlackApiError {
  ok?: boolean;
  error?: string;
  needed?: string;
  provided?: string;
}

interface SlackChannelInfo extends SlackApiError {
  channel?: {
    name?: string;
    properties?: {
      tabs?: Array<{
        id?: string;
        type?: string;
        label?: string;
        data?: { folder_bookmark_id?: string };
      }>;
    };
  };
}

interface SlackBookmarks extends SlackApiError {
  bookmarks?: Array<{
    id?: string;
    title?: string;
    type?: string;
    link?: string;
    entity_id?: string;
    parent_id?: string;
  }>;
}

interface SlackFiles extends SlackApiError {
  files?: Array<{
    id?: string;
    name?: string;
    title?: string;
    permalink?: string;
    mimetype?: string;
    external_type?: string;
  }>;
}

function channelId(platformId: string): string {
  const id = platformId.startsWith('slack:') ? platformId.slice('slack:'.length) : platformId;
  if (!/^[CDG][A-Z0-9]+$/.test(id)) throw new Error(`Invalid Slack conversation id: ${platformId}`);
  return id;
}

async function slackJson<T extends SlackApiError>(
  fetchImpl: FetchLike,
  token: string,
  method: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetchImpl(`https://slack.com/api/${method}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`Slack ${method} failed with HTTP ${response.status}`);
  return (await response.json()) as T;
}

function warning(method: string, result: SlackApiError): string {
  const scope = result.needed ? `; add OAuth scope ${result.needed}` : '';
  return `${method}: ${result.error ?? 'unknown Slack API error'}${scope}`;
}

/** List bounded metadata for folders, bookmarks, and files in one Slack conversation. */
export async function listSlackChannelResources(
  token: string,
  platformId: string,
  fetchImpl: FetchLike = fetch,
  options: { includeFiles?: boolean } = {},
): Promise<ChannelResourceListing> {
  const id = channelId(platformId);
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  const includeFiles = options.includeFiles ?? true;
  const [info, bookmarks, files] = await Promise.all([
    slackJson<SlackChannelInfo>(fetchImpl, token, `conversations.info?channel=${encodeURIComponent(id)}`),
    slackJson<SlackBookmarks>(fetchImpl, token, 'bookmarks.list', {
      method: 'POST',
      headers,
      body: JSON.stringify({ channel_id: id }),
    }),
    includeFiles
      ? slackJson<SlackFiles>(fetchImpl, token, `files.list?channel=${encodeURIComponent(id)}&count=100`)
      : Promise.resolve<SlackFiles>({ ok: true, files: [] }),
  ]);

  if (!info.ok) throw new Error(warning('conversations.info', info));

  const resources: ChannelResource[] = [];
  const warnings: string[] = [];
  const folders = new Map<string, string>();

  for (const tab of info.channel?.properties?.tabs ?? []) {
    if (tab.type !== 'folder') continue;
    const folderId = tab.data?.folder_bookmark_id;
    if (!folderId) continue;
    const title = tab.label?.trim() || 'Channel folder';
    folders.set(folderId, title);
    resources.push({ id: folderId, title, kind: 'folder' });
  }

  if (bookmarks.ok) {
    for (const item of bookmarks.bookmarks ?? []) {
      if (!item.id) continue;
      resources.push({
        id: item.id,
        title: item.title?.trim() || item.id,
        kind: 'bookmark',
        url: item.link,
        parentId: item.parent_id,
        parentTitle: item.parent_id ? folders.get(item.parent_id) : undefined,
      });
    }
  } else {
    warnings.push(warning('bookmarks.list', bookmarks));
  }

  if (files.ok) {
    for (const file of files.files ?? []) {
      if (!file.id) continue;
      resources.push({
        id: file.id,
        title: file.title?.trim() || file.name?.trim() || file.id,
        kind: 'file',
        url: file.permalink,
        mimeType: file.mimetype,
        externalType: file.external_type,
      });
    }
  } else {
    warnings.push(warning('files.list', files));
  }

  return {
    channelName: info.channel?.name,
    resources,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
