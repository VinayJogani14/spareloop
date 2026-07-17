import { spawn } from 'child_process';

/**
 * Best-effort OS notification. Never throws, never blocks the caller — a
 * missing notifier just means the message doesn't reach the desktop. Callers
 * are responsible for also logging the message so it's never silently lost.
 * (Deliberately does not depend on the daemon's logger, to avoid a
 * notify <-> daemon/loop circular import.)
 */
export function notify(title: string, message: string): void {
  try {
    if (process.platform === 'darwin') {
      const script = `display notification ${quoteAppleScript(message)} with title ${quoteAppleScript(title)}`;
      spawn('osascript', ['-e', script], { stdio: 'ignore' }).on('error', () => {});
    } else if (process.platform === 'linux') {
      spawn('notify-send', [title, message], { stdio: 'ignore' }).on('error', () => {});
    }
    // Other platforms (no known CLI notifier): silently no-op; caller's log call still records it.
  } catch {
    // Never let a notification failure affect the caller.
  }
}

function quoteAppleScript(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
