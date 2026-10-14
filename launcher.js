// Opens NeoMux in its own app window (Edge/Chrome --app). Closing that window
// stops the server, which wipes the session's imports and intermediates.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { start, shutdown } = require('./server');

const env = process.env;
const BROWSERS = [
  [env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'],
  [env.ProgramFiles, 'Microsoft/Edge/Application/msedge.exe'],
  [env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'],
  [env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'],
]
  .filter(([base]) => base)
  .map(([base, rel]) => path.join(base, rel));

function openWindow(url) {
  const exe = BROWSERS.find((p) => fs.existsSync(p));
  if (!exe) {
    // No Chromium browser: fall back to the default one. The server then lives until this process is closed.
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return null;
  }
  // A dedicated profile makes this a separate browser process that exits when the window closes.
  const profile = path.join(env.LOCALAPPDATA || __dirname, 'NeoMux', 'browser');
  return spawn(exe, [
    `--app=${url}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--window-size=1440,900', '--disable-features=Translate',
  ], { stdio: 'ignore' });
}

start()
  .then((url) => {
    const win = openWindow(url);
    win?.on('exit', shutdown);
  })
  .catch((e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    // Already running: just bring up another window on the existing server.
    openWindow(`http://localhost:${Number(env.PORT) || 5177}`)?.unref();
    process.exit(0);
  });
