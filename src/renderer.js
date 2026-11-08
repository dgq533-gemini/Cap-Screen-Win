const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BGS = [['#5b4bff', '#e0488f'], ['#0f2027', '#2c5364'], ['#ff9966', '#ff5e62'], ['#0f9b8e', '#2fd27a'], ['#2a2d33', '#4a4f58']];
const cfg = { bg: 0, pad: 80, radius: 24, shadow: 60, zoom: 1.9, cursor: 1.4, auto: true, sync: 0, smooth: 5, win: true };
const FPS = 60;

const video = $('#video'), canvas = $('#c'), ctx = canvas.getContext('2d');
let meta = null, cam = null, exporting = false;

// ---------- 录制 ----------
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 3200);
}

$('#rec').onclick = async () => {
  $('#rec').disabled = true;
  localStorage.setItem('cd', $('#cd').value);
  if (!(await api.startRecording(+$('#cd').value))) $('#rec').disabled = false;
};
api.onDone(({ file, meta: m }) => {
  $('#rec').disabled = false;
  openEditor(encodeURI('file:///' + file.replace(/\\/g, '/')), m);
});
api.onError(msg => { $('#rec').disabled = false; if (msg) toast(msg); });
$('#cd').value = localStorage.getItem('cd') || '3';

// ---------- 自定义快捷键 ----------
let hotkey = localStorage.getItem('hotkey') || 'Control+Shift+R';
const showHotkey = () => { $('#hk').value = hotkey.replace('Control', 'Ctrl'); };
showHotkey();
api.setHotkey(hotkey);
$('#hk').onkeydown = async e => {
  e.preventDefault();
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
  const mods = [];
  if (e.ctrlKey) mods.push('Control'); if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift'); if (e.metaKey) mods.push('Super');
  const c = e.code;
  const key = c.startsWith('Key') ? c.slice(3) : c.startsWith('Digit') ? c.slice(5) : /^F\d+$/.test(c) ? c : null;
  if (!key || (!mods.length && !/^F/.test(key))) return toast('请包含 Ctrl / Alt / Shift，或使用 F 键');
  const acc = [...mods, key].join('+');
  if (await api.setHotkey(acc)) { hotkey = acc; localStorage.setItem('hotkey', acc); showHotkey(); toast('快捷键已更新'); }
  else toast('该快捷键被占用，请换一个');
};

// ---------- 编辑器 ----------
function openEditor(url, m) {
  meta = m;
  $('#home').style.display = 'none';
  $('#editor').style.display = 'flex';
  video.src = url;
  video.onloadedmetadata = () => {
    applyPreset(recommended(), '', true);
    // MediaRecorder 产出的 webm 没有时长信息，通过跳到末尾来修复
    if (video.duration === Infinity) {
      video.currentTime = 1e101;
      video.ontimeupdate = () => { video.ontimeupdate = null; video.currentTime = 0; rebuild(); };
    } else rebuild();
  };
  requestAnimationFrame(loop);
}

function duration() { return isFinite(video.duration) ? video.duration : meta.duration / 1000; }

// 预先模拟整条镜头轨迹（弹簧式平滑），这样拖动时间轴也能得到一致的画面
function rebuild() {
  const dur = duration(), n = Math.ceil(dur * FPS) + 1, dt = 1 / FPS;
  const S = 6;
  const A = new Float32Array(n * S); // 视野宽, 视野高, 中心x, 中心y, 光标x, 光标y（均为占整屏的比例）
  const ev = meta.events.filter(e => e.k !== 'w');
  const lag = cfg.sync / 1000;
  const clicks = ev.filter(e => e.k === 'c').map(e => ({ t: e.t / 1000 + lag, x: e.x, y: e.y }));
  const ct = clicks.map(c => c.t);

  // 前台窗口时间线：停留不足 0.6 秒的窗口（Alt+Tab 经过、弹窗一闪而过）忽略；同一窗口的移动/缩放保留
  const wraw = meta.events.filter(e => e.k === 'w'), wl = [];
  wraw.forEach((e, i) => {
    const d = ((wraw[i + 1] ? wraw[i + 1].t : Infinity) - e.t) / 1000;
    if (wl.length && e.id !== wl[wl.length - 1].id && d < 0.6) return;
    wl.push(e);
  });
  // 窗口 → 目标视野：等比例取景，画框大小不变。窗口太小、或放大不足 1.25 倍（窗口本来就很大）时不处理
  const frameOf = e => {
    if (!e || !e.r) return null;
    const [x0, y0, x1, y1] = e.r, ww = x1 - x0, wh = y1 - y0;
    const f = Math.max(ww, wh) * 1.08;
    if (ww < .25 || wh < .25 || f > .8) return null;
    const ff = Math.max(1 / 2.2, f);
    return { fw: ff, fh: ff, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  };
  // 允许镜头越出屏幕边缘一点点（用模糊背景补），这样靠边的窗口也能尽量居中
  const OV = .12;
  const lim = (c, f) => Math.min(Math.max(c, f / 2 - OV * f), 1 - f / 2 + OV * f);

  let k = 0, wi = 0, tx = ev.length ? ev[0].x : .5, ty = ev.length ? ev[0].y : .5;
  let mx = tx, my = ty, fw = 1, fh = 1, cx = .5, cy = .5;
  const dead = (d, dz) => (Math.abs(d) <= dz ? 0 : d - Math.sign(d) * dz);
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    while (k < ev.length && ev[k].t / 1000 + lag <= t) { tx = ev[k].x; ty = ev[k].y; k++; }
    mx += (tx - mx) * (1 - Math.exp(-dt * 45));
    my += (ty - my) * (1 - Math.exp(-dt * 45));

    while (wi < wl.length && wl[wi].t / 1000 <= t) wi++;
    const wf = cfg.win ? frameOf(wi > 0 ? wl[wi - 1] : null) : null;
    const on = cfg.auto && ct.some(c => t >= c - 0.25 && t <= c + 1.3);

    let tfw = 1, tfh = 1, gx = .5, gy = .5;
    if (wf) { tfw = wf.fw; tfh = wf.fh; gx = wf.cx; gy = wf.cy; }
    else if (on) {
      tfw = tfh = 1 / cfg.zoom;
      gx = cx + dead(mx - cx, fw * .25); gy = cy + dead(my - cy, fh * .25);   // 死区：光标在中间区域内移动时镜头不动
    }
    // 缩放和平移用同一个速度，画面才会一起到位，不会出现"先缩放、后平移"的错位
    const k1 = 1 - Math.exp(-dt * (6.2 - cfg.smooth * 0.45));
    fw += (tfw - fw) * k1; fh += (tfh - fh) * k1;
    cx += (gx - cx) * k1; cy += (gy - cy) * k1;
    A.set([fw, fh, lim(cx, fw), lim(cy, fh), mx, my], i * S);
  }
  cam = { A, n, S, clicks };
}

function rr(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }

function drawCursor(x, y, s) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(0, 17); ctx.lineTo(4.5, 13); ctx.lineTo(7.5, 20);
  ctx.lineTo(10, 19); ctx.lineTo(7, 12); ctx.lineTo(13, 12); ctx.closePath();
  ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = 6;
  ctx.fillStyle = '#fff'; ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 1.2; ctx.strokeStyle = '#111'; ctx.stroke();
  ctx.restore();
}

const tiny = document.createElement('canvas');
tiny.width = 48; tiny.height = 27;
const tctx = tiny.getContext('2d');

function draw() {
  const W = canvas.width, H = canvas.height;
  const u = Math.min(W, H) / 1080, pad = cfg.pad * u;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, BGS[cfg.bg][0]); g.addColorStop(1, BGS[cfg.bg][1]);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!cam || !vw) return;

  const t = video.currentTime, i = Math.min(cam.n - 1, Math.floor(t * FPS)) * cam.S;
  const [fw, fh, cx, cy, mx, my] = Array.from(cam.A.subarray(i, i + 6));
  const sw = fw * vw, sh = fh * vh;                      // 源画面中被取景的区域（像素）
  const s = Math.min((W - pad * 2) / sw, (H - pad * 2) / sh);
  const rw = sw * s, rh = sh * s, rx = (W - rw) / 2, ry = (H - rh) / 2;
  const vx0 = cx - fw / 2, vy0 = cy - fh / 2;
  const map = (x, y) => [rx + ((x - vx0) / fw) * rw, ry + ((y - vy0) / fh) * rh];

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = cfg.shadow * u; ctx.shadowOffsetY = (cfg.shadow * u) / 3;
  ctx.fillStyle = '#000'; rr(rx, ry, rw, rh, cfg.radius * u); ctx.fill();
  ctx.restore();

  ctx.save();
  rr(rx, ry, rw, rh, cfg.radius * u); ctx.clip();
  const ix0 = Math.max(vx0, 0), iy0 = Math.max(vy0, 0), ix1 = Math.min(vx0 + fw, 1), iy1 = Math.min(vy0 + fh, 1);
  if (ix0 > vx0 || iy0 > vy0 || ix1 < vx0 + fw || iy1 < vy0 + fh) {   // 越界：用缩小再放大的画面当模糊底
    tctx.drawImage(video, 0, 0, tiny.width, tiny.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tiny, rx, ry, rw, rh);
    ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(rx, ry, rw, rh);
  }
  ctx.drawImage(video, ix0 * vw, iy0 * vh, (ix1 - ix0) * vw, (iy1 - iy0) * vh,
    rx + ((ix0 - vx0) / fw) * rw, ry + ((iy0 - vy0) / fh) * rh, ((ix1 - ix0) / fw) * rw, ((iy1 - iy0) / fh) * rh);

  for (const c of cam.clicks) {            // 点击涟漪
    const p = (t - c.t) / 0.45;
    if (p < 0 || p > 1) continue;
    const [px, py] = map(c.x, c.y);
    ctx.beginPath(); ctx.arc(px, py, (14 + 46 * p) * u * cfg.cursor, 0, 7);
    ctx.lineWidth = 4 * u; ctx.strokeStyle = `rgba(255,255,255,${1 - p})`; ctx.stroke();
  }
  const [px, py] = map(mx, my);
  drawCursor(px, py, cfg.cursor * 1.6 * u * (1 + (1 / fw - 1) * .35));
  ctx.restore();
}

function loop() {
  draw();
  if (!exporting) {
    $('#seek').value = (video.currentTime / (duration() || 1)) * 1000;
    const s = Math.floor(video.currentTime);
    $('#time').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  requestAnimationFrame(loop);
}

// ---------- 控件 ----------
BGS.forEach((b, i) => {
  const el = document.createElement('i');
  el.style.background = `linear-gradient(135deg,${b[0]},${b[1]})`;
  el.onclick = () => { cfg.bg = i; [...$('#sw').children].forEach((c, j) => c.classList.toggle('on', i === j)); };
  if (i === 0) el.classList.add('on');
  $('#sw').appendChild(el);
});
['pad', 'radius', 'shadow', 'cursor'].forEach(k => ($('#' + k).oninput = e => (cfg[k] = +e.target.value)));
$('#zoom').oninput = e => { cfg.zoom = +e.target.value; rebuild(); };
$('#sync').oninput = e => { cfg.sync = +e.target.value; rebuild(); };
$('#win').onchange = e => { cfg.win = e.target.checked; rebuild(); };
$('#smooth').oninput = e => { cfg.smooth = +e.target.value; rebuild(); };

// 滑块旁的数值显示
const UNITS = { pad: ' px', radius: ' px', shadow: '', zoom: ' ×', cursor: ' ×', smooth: '', sync: ' ms' };
for (const k in UNITS) {
  const input = $('#' + k), o = document.createElement('output');
  input.before(o);
  input.addEventListener('input', () => (o.textContent = input.value + UNITS[k]));
  o.textContent = input.value + UNITS[k];
}
const refreshOut = () => { for (const k in UNITS) $('#' + k).dispatchEvent(new Event('input')); };

// 按本机屏幕分辨率自动推荐（光标同步是按本机校准的，不在其中）
function recommended() {
  const vw = video.videoWidth || 1920;
  return { bg: cfg.bg, pad: 70, radius: 20, shadow: 50, cursor: 1.5, smooth: 7, auto: true, win: true,
           zoom: vw >= 3000 ? 2.0 : vw >= 2400 ? 1.8 : vw >= 1800 ? 1.6 : 1.4 };
}
function applyPreset(p, name, quiet) {
  Object.assign(cfg, p);
  for (const k of ['pad', 'radius', 'shadow', 'zoom', 'cursor', 'smooth']) $('#' + k).value = cfg[k];
  $('#auto').checked = cfg.auto;
  $('#win').checked = cfg.win;
  [...$('#sw').children].forEach((c, j) => c.classList.toggle('on', j === cfg.bg));
  refreshOut();
  if (!quiet) { rebuild(); toast('已按本机屏幕应用' + name); }
}
$('#best').onclick = () => applyPreset(recommended(), '推荐设置');

// 画面比例
const RATIOS = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:3': [1440, 1080], '3:4': [1080, 1440], '4:5': [1080, 1350], '21:9': [2520, 1080] };
$('#ratio').onchange = e => { [canvas.width, canvas.height] = RATIOS[e.target.value]; };
$('#auto').onchange = e => { cfg.auto = e.target.checked; rebuild(); };
$('#seek').oninput = e => (video.currentTime = (e.target.value / 1000) * duration());
$('#play').onclick = () => {
  if (video.paused) { video.play(); $('#play').textContent = '暂停'; } else { video.pause(); $('#play').textContent = '播放'; }
};
$('#again').onclick = () => { video.pause(); $('#editor').style.display = 'none'; $('#home').style.display = 'block'; };

// ---------- 导出：把画布实时录成视频，再交给 ffmpeg 转码 ----------
$('#export').onclick = async () => {
  const fmt = $('#fmt').value, st = $('#status');
  exporting = true; video.pause();
  video.currentTime = 0;
  await new Promise(r => (video.onseeked = r));
  const cs = canvas.captureStream(FPS);
  try { video.captureStream().getAudioTracks().forEach(t => cs.addTrack(t)); } catch {}
  const parts = [];
  const r = new MediaRecorder(cs, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 25e6 });
  r.ondataavailable = e => e.data.size && parts.push(e.data);
  const stopped = new Promise(res => (r.onstop = res));
  video.onended = () => r.stop();
  const tick = setInterval(() => (st.textContent = `导出中… ${Math.round((video.currentTime / duration()) * 100)}%`), 300);
  r.start(1000); await video.play();
  await stopped; clearInterval(tick);
  video.onended = null; exporting = false;
  st.textContent = '正在转码…';
  try {
    const ok = await api.exportFile(await new Blob(parts).arrayBuffer(), fmt);
    st.textContent = ok ? '已导出' : '已取消';
  } catch (e) { st.textContent = '导出失败：' + e.message; }
};
