import { getWebhookUrl, WebhookChannel } from './webhookConfig';

/**
 * POST to a Slack or Discord incoming-webhook URL. Uses the global `fetch`
 * (stable since Node 18, which is this package's minimum engine - no extra
 * HTTP dependency needed). Best-effort: never throws, so a webhook outage
 * never takes down the daemon.
 */
export async function sendWebhook(channel: WebhookChannel, title: string, message: string): Promise<boolean> {
  const url = getWebhookUrl(channel);
  if (!url) return false;
  try {
    const body =
      channel === 'slack'
        ? { text: `*${title}*\n${message}` }
        : { content: `**${title}**\n${message}` };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function sendWebhooksFireAndForget(title: string, message: string): void {
  for (const channel of ['slack', 'discord'] as WebhookChannel[]) {
    if (getWebhookUrl(channel)) {
      sendWebhook(channel, title, message).catch(() => {});
    }
  }
}
