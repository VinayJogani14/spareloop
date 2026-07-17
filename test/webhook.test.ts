import { test } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';

process.env.SPARELOOP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'spareloop-webhook-'));

import { sendWebhook } from '../src/notify/webhook';
import { setWebhookUrl, getWebhookUrl, listWebhooks } from '../src/notify/webhookConfig';

function withEchoServer(handler: (body: any) => void): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        handler(JSON.parse(data));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    server.listen(0, () => {
      const port = (server.address() as any).port;
      resolve({
        url: `http://127.0.0.1:${port}/webhook`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

test('sendWebhook: real HTTP POST to slack uses `text` field with title+message', async () => {
  let received: any = null;
  const { url, close } = await withEchoServer((body) => (received = body));
  setWebhookUrl('slack', url);

  const ok = await sendWebhook('slack', 'spareloop: task succeeded', 'did the thing');
  assert.equal(ok, true);
  assert.ok(received);
  assert.match(received.text, /spareloop: task succeeded/);
  assert.match(received.text, /did the thing/);

  await close();
});

test('sendWebhook: real HTTP POST to discord uses `content` field', async () => {
  let received: any = null;
  const { url, close } = await withEchoServer((body) => (received = body));
  setWebhookUrl('discord', url);

  await sendWebhook('discord', 'spareloop: burn-rate alert', '75% of typical window usage');
  assert.ok(received.content);
  assert.match(received.content, /burn-rate alert/);

  await close();
});

test('sendWebhook returns false (not throws) when unconfigured or unreachable', async () => {
  setWebhookUrl('slack', null);
  assert.equal(await sendWebhook('slack', 't', 'm'), false);

  setWebhookUrl('discord', 'http://127.0.0.1:1/definitely-not-listening');
  assert.equal(await sendWebhook('discord', 't', 'm'), false);
});

test('webhook config: set/unset/list round-trip through kv_state', () => {
  setWebhookUrl('slack', 'https://hooks.slack.com/services/x');
  assert.equal(getWebhookUrl('slack'), 'https://hooks.slack.com/services/x');
  const all = listWebhooks();
  assert.ok(all.some((w) => w.channel === 'slack' && w.url === 'https://hooks.slack.com/services/x'));

  setWebhookUrl('slack', null);
  assert.equal(getWebhookUrl('slack'), null);
});
