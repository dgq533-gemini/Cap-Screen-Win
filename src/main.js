const { app, BrowserWindow, ipcMain, screen, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

let uIOhook = null;
try { ({ uIOhook } = require('uiohook-napi')); } catch (e) { console.warn('uiohook-napi 不可用，将无法记录点击:', e.message); }
const ffmpeg = (require('ffmpeg-static') || '').replace('app.asar', 'app.asar.unpacked');

const TITLE = 'AiFreeGens.com - Studio Win';
// 常驻的 PowerShell 进程：每 100ms 汇报最前面窗口的位置（物理像素，已声明 DPI 感知）
const PS_SCRIPT = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public struct RECT { public int L, T, R, B; }
public class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
}
"@
[W]::SetProcessDPIAware() | Out-Null
while ($true) {
  $h = [W]::GetForegroundWindow()
  $r = New-Object RECT
  if ($h -ne [IntPtr]::Zero -and [W]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) -eq 0) {
    [Console]::Out.WriteLine(("{0},{1},{2},{3},{4}" -f $h.ToInt64(), $r.L, $r.T, $r.R, $r.B))
  }
  Start-Sleep -Milliseconds 100
}
`;
let psProc = null, fg = null;

function startWindowWatcher() {
  try {
    psProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(PS_SCRIPT, 'utf16le').toString('base64')], { windowsHide: true });
  } catch { return; }
  let buf = '';
  psProc.stdout.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); onWinLine(line); }
  });
  psProc.on('error', () => {});
}

function onWinLine(line) {
  const p = line.split(',');
  if (p.length < 5) return;
  const [l, t, r, bt] = p.slice(1).map(Number);
  const d = screen.getPrimaryDisplay(), W = d.bounds.width * d.scaleFactor, H = d.bounds.height * d.scaleFactor;
  const x0 = Math.max(0, l) / W, y0 = Math.max(0, t) / H, x1 = Math.min(W, r) / W, y1 = Math.min(H, bt) / H;
  const rect = x1 - x0 > 0.02 && y1 - y0 > 0.02 ? [x0, y0, x1, y1] : null;
  const key = p[0] + (rect ? rect.map(v => v.toFixed(3)).join() : '');
  if (fg && fg.key === key) return;
  fg = { key, id: p[0], r: rect };
  if (rec) rec.events.push({ t: Date.now(), k: 'w', id: p[0], r: rect });
}

let win, hotkey = 'Control+Shift+R', rec = null, hookStarted = false;

app.whenReady().then(() => {
  win = new BrowserWindow({
    title: TITLE, width: 1360, height: 840, minWidth: 1100, minHeight: 740,
    backgroundColor: '#15171c', autoHideMenuBar: true,
    // 页面只加载本地文件；关闭 webSecurity 是为了让本地视频不污染画布，导出才能读取画面
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false, webSecurity: false }
  });
  win.on('page-title-updated', e => e.preventDefault());
  win.loadFile(path.join(__dirname, 'index.html'));
  registerHotkey(hotkey);
  startWindowWatcher();
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); try { psProc && psProc.kill(); } catch {} });
app.on('window-all-closed', () => app.quit());

function onHotkey() { if (rec) stopRecording(); else if (counting) cancelled = true; }

function registerHotkey(acc) {
  globalShortcut.unregisterAll();
  let ok = false;
  try { ok = globalShortcut.register(acc, onHotkey); } catch {}
  if (ok) hotkey = acc;
  else { try { globalShortcut.register(hotkey, onHotkey); } catch {} }
  return ok;
}
ipcMain.handle('hotkey:set', (_, acc) => registerHotkey(acc));

// ---------- 录制（ffmpeg gdigrab，不录系统光标） ----------
function norm(p, b) { return { x: (p.x - b.x) / b.width, y: (p.y - b.y) / b.height }; }

function startRecording() {
  if (rec) return false;
  const d = screen.getPrimaryDisplay(), b = d.bounds, sf = d.scaleFactor;
  const w = Math.floor((b.width * sf) / 2) * 2, h = Math.floor((b.height * sf) / 2) * 2;
  const file = path.join(os.tmpdir(), 'studio_' + Date.now() + '.mp4');

  // 让 ffmpeg 以高 DPI 感知方式运行，否则缩放后只会录到左上角一部分
  try {
    execFileSync('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers',
      '/v', ffmpeg, '/t', 'REG_SZ', '/d', '~ HIGHDPIAWARE', '/f'], { stdio: 'ignore' });
  } catch {}

  win.hide();
  const args = ['-y', '-f', 'gdigrab', '-framerate', '60', '-draw_mouse', '0',
    '-offset_x', '0', '-offset_y', '0', '-video_size', `${w}x${h}`, '-i', 'desktop',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-progress', 'pipe:1', '-stats_period', '0.1', '-nostats', file];
  const ff = spawn(ffmpeg, args);
  const r = { ff, file, b, events: [], sw: Infinity, spawnWall: Date.now(), started: false, err: '', last: '' };
  rec = r;

  ff.stderr.on('data', d => { r.err = (r.err + d).slice(-2000); });
  ff.stdout.on('data', d => {
    const m = /out_time_us=(\d+)/g; let x, us = null;
    while ((x = m.exec(d))) us = +x[1];
    if (us === null) return;
    // 取最小值：进度输出总是比真实画面晚一点，最小值最接近第一帧的真实时间
    r.sw = Math.min(r.sw, Date.now() - us / 1000);
    r.started = true;
  });
  ff.on('error', e => { fail('无法启动 ffmpeg：' + e.message); });

  r.timer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    const key = p.x + ',' + p.y;
    if (key === r.last) return;
    r.last = key;
    r.events.push({ t: Date.now(), k: 'm', ...norm(p, b) });
  }, 4);

  if (uIOhook && !hookStarted) {
    uIOhook.on('mousedown', e => {
      if (!rec) return;
      const p = screen.screenToDipPoint({ x: e.x, y: e.y });
      rec.events.push({ t: Date.now(), k: 'c', ...norm(p, rec.b) });
    });
    uIOhook.start();
    hookStarted = true;
  }
  return true;
}

function showMain() {
  if (win.isMinimized()) win.restore();
  win.setAlwaysOnTop(true); win.show(); win.focus(); win.setAlwaysOnTop(false);
}

function fail(msg) {
  if (rec) { clearInterval(rec.timer); try { rec.ff.kill(); } catch {} rec = null; }
  showMain();
  win.webContents.send('rec-error', msg);
}

async function stopRecording() {
  const r = rec;
  if (!r) return;
  rec = null;
  clearInterval(r.timer);
  const stopWall = Date.now();
  await new Promise(res => {
    const kill = setTimeout(() => { try { r.ff.kill(); } catch {} }, 8000);
    r.ff.once('close', () => { clearTimeout(kill); res(); });
    try { r.ff.stdin.write('q'); } catch { try { r.ff.kill(); } catch {} }
  });
  showMain();
  if (!fs.existsSync(r.file) || fs.statSync(r.file).size < 1000) {
    win.webContents.send('rec-error', '没有录到画面。ffmpeg 输出：' + r.err.slice(-300));
    return;
  }
  const sw = isFinite(r.sw) ? r.sw : r.spawnWall;
  const meta = {
    duration: stopWall - sw,
    display: { w: r.b.width, h: r.b.height },
    events: r.events.map(e => ({ ...e, t: e.t - sw }))
  };
  win.webContents.send('rec-done', { file: r.file, meta });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let counting = false, cancelled = false;

// 倒计时：先隐藏主窗口，在屏幕中央显示不抢焦点的 3-2-1，数完销毁后再多等一会儿，确保两者都不会被录进去
async function beginRecording(secs) {
  if (rec || counting) return false;
  counting = true; cancelled = false;
  win.hide();
  const b = screen.getPrimaryDisplay().bounds;
  const ov = new BrowserWindow({
    width: 200, height: 200, x: Math.round(b.x + (b.width - 200) / 2), y: Math.round(b.y + (b.height - 200) / 2),
    frame: false, transparent: true, alwaysOnTop: true, focusable: false, skipTaskbar: true,
    hasShadow: false, resizable: false, show: false
  });
  ov.setIgnoreMouseEvents(true);
  const html = '<body style="margin:0;height:100vh;display:grid;place-items:center;background:transparent">' +
    '<div id="n" style="width:150px;height:150px;border-radius:50%;background:rgba(20,22,28,.88);color:#fff;' +
    'font:700 84px Segoe UI,sans-serif;display:grid;place-items:center">' + secs + '</div></body>';
  await ov.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  ov.setAlwaysOnTop(true, 'screen-saver');
  ov.showInactive();
  for (let i = secs; i > 0 && !cancelled; i--) {
    await ov.webContents.executeJavaScript(`document.getElementById('n').textContent='${i}'`);
    await sleep(1000);
  }
  ov.destroy();
  counting = false;
  if (cancelled) { showMain(); win.webContents.send('rec-error', ''); return false; }
  await sleep(400);
  startRecording();
  return true;
}
ipcMain.handle('rec:start', (_, secs) => beginRecording(Math.min(3, Math.max(1, secs | 0))));

// ---------- 导出 ----------
ipcMain.handle('export', async (_, buf, fmt) => {
  const { filePath } = await dialog.showSaveDialog(win, {
    defaultPath: `recording.${fmt}`, filters: [{ name: fmt.toUpperCase(), extensions: [fmt] }]
  });
  if (!filePath) return false;
  const data = Buffer.from(buf);
  if (fmt === 'webm') { fs.writeFileSync(filePath, data); return true; }
  const tmp = path.join(os.tmpdir(), 'studio_' + Date.now() + '.webm');
  fs.writeFileSync(tmp, data);
  const args = fmt === 'gif'
    ? ['-y', '-i', tmp, '-vf', 'fps=20,scale=960:-1:flags=lanczos', '-loop', '0', filePath]
    : ['-y', '-i', tmp, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-an', filePath];
  await new Promise((res, rej) => {
    const p = spawn(ffmpeg, args);
    p.on('error', rej);
    p.on('close', c => (c ? rej(new Error('ffmpeg 退出码 ' + c)) : res()));
  });
  fs.unlink(tmp, () => {});
  return true;
});
