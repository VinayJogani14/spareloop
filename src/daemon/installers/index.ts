import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { daemonLogPath, dataDir } from '../../core/paths';

export type Backend = 'launchd' | 'systemd' | 'cron';

export function detectBackend(): Backend {
  if (process.platform === 'darwin') return 'launchd';
  if (process.platform === 'linux') {
    try {
      execSync('systemctl --user show-environment', { stdio: 'ignore' });
      return 'systemd';
    } catch {
      return 'cron';
    }
  }
  return 'cron';
}

function spareloopBin(): string {
  // Resolve the CLI entry actually running right now, so the daemon uses the
  // same install (global, npx cache, or local checkout).
  return process.argv[1];
}

function nodeBin(): string {
  return process.execPath;
}

export function install(backend: Backend): string {
  switch (backend) {
    case 'launchd':
      return installLaunchd();
    case 'systemd':
      return installSystemd();
    case 'cron':
      return installCron();
  }
}

export function uninstall(backend: Backend): string {
  switch (backend) {
    case 'launchd': {
      const plist = launchdPlistPath();
      try {
        execSync(`launchctl unload ${JSON.stringify(plist)}`, { stdio: 'ignore' });
      } catch {
        /* not loaded */
      }
      if (fs.existsSync(plist)) fs.unlinkSync(plist);
      return `Removed ${plist}`;
    }
    case 'systemd': {
      try {
        execSync('systemctl --user disable --now spareloop.service', { stdio: 'ignore' });
      } catch {
        /* not enabled */
      }
      const unit = systemdUnitPath();
      if (fs.existsSync(unit)) fs.unlinkSync(unit);
      return `Removed ${unit}`;
    }
    case 'cron': {
      const current = readCrontab();
      const filtered = current
        .split('\n')
        .filter((l) => !l.includes('# spareloop'))
        .join('\n');
      writeCrontab(filtered);
      return 'Removed spareloop crontab entry';
    }
  }
}

function launchdPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.spareloop.daemon.plist');
}

function installLaunchd(): string {
  const plistPath = launchdPlistPath();
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.spareloop.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin()}</string>
    <string>${spareloopBin()}</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${daemonLogPath()}</string>
  <key>StandardErrorPath</key><string>${daemonLogPath()}</string>
  <key>WorkingDirectory</key><string>${dataDir()}</string>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist);
  try {
    execSync(`launchctl unload ${JSON.stringify(plistPath)}`, { stdio: 'ignore' });
  } catch {
    /* first install */
  }
  execSync(`launchctl load ${JSON.stringify(plistPath)}`);
  return `Installed + loaded ${plistPath} (persistent daemon, restarts on login/crash)`;
}

function systemdUnitPath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', 'spareloop.service');
}

function installSystemd(): string {
  const unitPath = systemdUnitPath();
  const unit = `[Unit]
Description=spareloop daemon - AI CLI task queue + usage window optimizer

[Service]
ExecStart=${nodeBin()} ${spareloopBin()} daemon run
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  fs.writeFileSync(unitPath, unit);
  execSync('systemctl --user daemon-reload');
  execSync('systemctl --user enable --now spareloop.service');
  return `Installed + started ${unitPath}`;
}

function readCrontab(): string {
  try {
    return execSync('crontab -l', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch {
    return '';
  }
}

function writeCrontab(content: string): void {
  execSync('crontab -', { input: content.endsWith('\n') || content === '' ? content : content + '\n' });
}

function installCron(): string {
  const line = `* * * * * ${nodeBin()} ${spareloopBin()} daemon tick >> ${daemonLogPath()} 2>&1 # spareloop`;
  const current = readCrontab();
  if (current.includes('# spareloop')) return 'spareloop crontab entry already present';
  writeCrontab(current + line + '\n');
  return 'Added spareloop crontab entry (stateless tick every minute)';
}
