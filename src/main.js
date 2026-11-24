const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { pathToFileURL } = require('url');

let win;
let currentJob = null;
let proxyJob = null;

function ffmpegPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'ffmpeg.exe');
  const local = path.join(__dirname, '..', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(local)) return local;
  return 'ffmpeg'; // dev fallback: system ffmpeg
}

function createWindow() {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0e0f13',
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0e0f13', symbolColor: '#a8abb6', height: 40 },
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');
app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  killJob(currentJob);
  killJob(proxyJob);
  app.quit();
});

function killJob(job) {
  if (job && job.proc && !job.proc.killed) {
    try { job.proc.kill('SIGKILL'); } catch (_) {}
  }
}

// ---------- probing ----------
function probe(file) {
  return new Promise((resolve) => {
    execFile(ffmpegPath(), ['-hide_banner', '-i', file], { windowsHide: true, maxBuffer: 1 << 22 }, (_err, _out, stderr) => {
      const s = String(stderr || '');
      const info = { duration: 0, width: 0, height: 0, fps: 0, vcodec: '', acodec: '', hasAudio: false, hasVideo: false, bitrate: 0 };
      const d = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (d) info.duration = (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]);
      const br = s.match(/bitrate:\s*(\d+)\s*kb\/s/);
      if (br) info.bitrate = +br[1];
      const v = s.match(/Stream #\d+:\d+[^:]*: Video: ([^\s,]+)[^\n]*?(\d{2,5})x(\d{2,5})/);
      if (v) { info.hasVideo = true; info.vcodec = v[1]; info.width = +v[2]; info.height = +v[3]; }
      const f = s.match(/Video:[^\n]*?([\d.]+) fps/) || s.match(/Video:[^\n]*?([\d.]+) tbr/);
      if (f) info.fps = parseFloat(f[1]);
      const a = s.match(/Stream #\d+:\d+[^:]*: Audio: ([^\s,]+)/);
      if (a) { info.hasAudio = true; info.acodec = a[1]; }
      resolve(info);
    });
  });
}

// ---------- hardware encoder detection ----------
let hwCache = null;
function testEncoder(name) {
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30', '-frames:v', '5', '-c:v', name, '-f', 'null', '-'];
    const p = execFile(ffmpegPath(), args, { windowsHide: true, timeout: 15000 }, (err) => resolve(!err));
    p.on('error', () => resolve(false));
  });
}
async function detectHw() {
  if (hwCache) return hwCache;
  const list = ['h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'hevc_qsv', 'h264_amf', 'hevc_amf'];
  const res = await Promise.all(list.map(testEncoder));
  hwCache = {};
  list.forEach((n, i) => (hwCache[n] = res[i]));
  return hwCache;
}

// ---------- running ffmpeg with progress ----------
function runFfmpeg(args, totalSec, onProgress) {
  const proc = spawn(ffmpegPath(), ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', ...args], { windowsHide: true });
  const job = { proc, cancelled: false };
  let errTail = '';
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
      if (m && totalSec > 0) {
        const sec = parseInt(m[1], 10) / 1e6;
        onProgress && onProgress(Math.max(0, Math.min(1, sec / totalSec)));
      }
      const sp = line.match(/^speed=\s*([\d.]+)x/);
      if (sp) job.speed = parseFloat(sp[1]);
    }
  });
  proc.stderr.on('data', (c) => { errTail = (errTail + c.toString()).slice(-4000); });
  job.done = new Promise((resolve) => {
    proc.on('error', (e) => resolve({ ok: false, error: String(e.message || e) }));
    proc.on('close', (code) => {
      if (job.cancelled) resolve({ ok: false, cancelled: true });
      else if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: errTail.split('\n').filter(Boolean).slice(-6).join('\n') });
    });
  });
  return job;
}

// ---------- IPC ----------
ipcMain.handle('open-video', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Открыть видео',
    properties: ['openFile'],
    filters: [
      { name: 'Видео', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', '3gp', 'ogv'] },
      { name: 'Все файлы', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});

ipcMain.handle('load-video', async (_e, file) => {
  if (!file || !fs.existsSync(file)) return { error: 'Файл не найден' };
  const info = await probe(file);
  const stat = fs.statSync(file);
  return { file, url: pathToFileURL(file).href, name: path.basename(file), size: stat.size, info };
});

ipcMain.handle('make-proxy', async (_e, file, duration) => {
  killJob(proxyJob);
  const out = path.join(os.tmpdir(), `clipcut-proxy-${Date.now()}.mp4`);
  const args = ['-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale='min(1280,iw)':-2,format=yuv420p",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-g', '30', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out];
  proxyJob = runFfmpeg(args, duration, (p) => win && win.webContents.send('proxy-progress', p));
  const r = await proxyJob.done;
  proxyJob = null;
  if (!r.ok) return { error: r.error || 'Не удалось подготовить превью' };
  return { url: pathToFileURL(out).href, path: out };
});

ipcMain.handle('detect-hw', () => detectHw());

ipcMain.handle('choose-output', async (_e, defName, ext) => {
  const names = { mp4: 'Видео MP4', webm: 'Видео WebM', gif: 'Анимация GIF', mp3: 'Аудио MP3', png: 'Изображение PNG', mov: 'Видео MOV' };
  const r = await dialog.showSaveDialog(win, {
    title: 'Сохранить как',
    defaultPath: path.join(app.getPath('videos'), defName),
    filters: [{ name: names[ext] || ext.toUpperCase(), extensions: [ext] }],
  });
  if (r.canceled || !r.filePath) return null;
  return r.filePath;
});

ipcMain.handle('export', async (_e, { args, total }) => {
  if (currentJob) return { ok: false, error: 'Экспорт уже идёт' };
  const started = Date.now();
  currentJob = runFfmpeg(args, total, (p) => {
    if (!win) return;
    const elapsed = (Date.now() - started) / 1000;
    const eta = p > 0.01 ? elapsed / p - elapsed : null;
    win.webContents.send('export-progress', { p, eta, speed: currentJob && currentJob.speed });
    win.setProgressBar(p);
  });
  const r = await currentJob.done;
  currentJob = null;
  if (win) win.setProgressBar(-1);
  if (r.ok && win && !win.isFocused()) win.flashFrame(true);
  return r;
});

ipcMain.handle('cancel-export', () => {
  if (currentJob) { currentJob.cancelled = true; killJob(currentJob); }
  return true;
});

ipcMain.handle('snapshot', async (_e, { file, time, out, vf }) => {
  const args = ['-ss', String(time), '-i', file, '-frames:v', '1'];
  if (vf) args.push('-vf', vf);
  args.push(out);
  const job = runFfmpeg(args, 0);
  return job.done;
});

ipcMain.handle('show-in-folder', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('open-path', (_e, p) => shell.openPath(p));
ipcMain.handle('file-size', (_e, p) => { try { return fs.statSync(p).size; } catch { return 0; } });
ipcMain.handle('platform', () => process.platform);

ipcMain.handle('waveform', async (_e, file) => {
  const out = path.join(os.tmpdir(), `clipcut-wave-${Date.now()}.png`);
  const args = ['-i', file, '-filter_complex', 'aformat=channel_layouts=mono,compand=gain=4,showwavespic=s=4000x80:colors=0x5f86ff', '-frames:v', '1', out];
  const r = await runFfmpeg(args, 0).done;
  if (!r.ok || !fs.existsSync(out)) return null;
  return pathToFileURL(out).href;
});
