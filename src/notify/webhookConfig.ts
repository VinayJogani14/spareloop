import { kvGet, kvSet } from '../core/db';

export type WebhookChannel = 'slack' | 'discord';

function key(channel: WebhookChannel): string {
  return `webhook:${channel}`;
}

export function getWebhookUrl(channel: WebhookChannel): string | null {
  return kvGet(key(channel)) || null;
}

export function setWebhookUrl(channel: WebhookChannel, url: string | null): void {
  kvSet(key(channel), url ?? '');
}

export function listWebhooks(): Array<{ channel: WebhookChannel; url: string | null }> {
  return (['slack', 'discord'] as WebhookChannel[]).map((channel) => ({
    channel,
    url: getWebhookUrl(channel),
  }));
}
