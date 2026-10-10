'use strict';
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const app = express();
const PORT = Number(process.env.PORT || 8080);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 100);
const MAX_DURATION_SECONDS = Number(process.env.MAX_DURATION_SECONDS || 900); // 15 minutes on free-tier infrastructure
const MAX_JOBS_IN_MEMORY = Number(process.env.MAX_JOBS_IN_MEMORY || 20);
const ALLOWED_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
app.use(cors({ origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(',').map(s => s.trim()), methods: ['GET','POST','DELETE'] }));
app.use(express.json({ limit: '1mb' }));

const tmpRoot = path.join(os.tmpdir(), 'saut-render-jobs');
fs.mkdirSync(tmpRoot, { recursive: true });
const jobs = new Map();
let activeJob = false;
const upload = multer({
  dest: tmpRoot,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 2 },
  fileFilter: (_req, file, cb) => {
    const ok = file.fieldname === 'audio' ? /^(audio\/|application\/octet-stream)/i.test(file.mimetype) || /\.(mp3|wav|m4a|aac|ogg|opus|flac|mp4|webm)$/i.test(file.originalname)
      : file.fieldname === 'cover' ? /^image\//i.test(file.mimetype) || /\.(png|jpe?g|webp)$/i.test(file.originalname) : false;
    cb(ok ? null : new Error('Unsupported file type.'), ok);
  }
});

function cleanJobFiles(job) {
  if (!job) return;
  for (const f of [job.audioPath, job.coverPath, job.subtitlePath, job.outputPath, job.logPath]) {
    if (f) { try { fs.unlinkSync(f); } catch {} }
  }
}
function publicJob(job) {
  return { id: job.id, status: job.status, progress: job.progress, message: job.message,
    duration: job.duration || null, outputBytes: job.outputBytes || null, createdAt: job.createdAt,
    finishedAt: job.finishedAt || null, error: job.error || null,
    downloadUrl: job.status === 'completed' ? `/api/jobs/${job.id}/download` : null };
}
function parseTimestamp(s) {
  const m = s.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(('0.' + (m[4] || '0')).replace(',', '.'));
}
function toAssTime(seconds) {
  const cs = Math.floor((seconds % 1) * 100);
  const total = Math.floor(seconds);
  return `${Math.floor(total/3600)}:${String(Math.floor(total/60)%60).padStart(2,'0')}:${String(total%60).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}
function assEscape(s) { return s.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, ' '); }
function createAss(text, duration, width, height, opts) {
  const size = Math.max(16, Math.min(64, Number(opts.lyricSize || 30) * width / 1280));
  const align = opts.lyricPosition === 'top' ? 8 : opts.lyricPosition === 'center' ? 5 : 2;
  const marginV = opts.lyricPosition === 'top' ? Math.round(height * 0.09) : opts.lyricPosition === 'center' ? 0 : Math.round(height * 0.08);
  const font = opts.lyricFont === 'serif' ? 'Noto Serif' : opts.lyricFont === 'sans' ? 'Noto Sans Arabic' : 'Noto Naskh Arabic';
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${font},${size},&H00FFFFFF,&H0000FFFF,&H99000000,&H55000000,0,0,0,0,100,100,0,0,1,2,1,${align},60,60,${marginV},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const rows = String(text || '').split(/\r?\n/).map(line => {
    const m = line.match(/^\s*\[(.+?)\]\s*(.*)$/);
    if (!m || !m[2].trim()) return null;
    const start = parseTimestamp(m[1]);
    if (start === null || start >= duration) return null;
    return { start, text: assEscape(m[2].trim()) };
  }).filter(Boolean).sort((a,b) => a.start - b.start);
  const events = rows.map((r, i) => `Dialogue: 0,${toAssTime(r.start)},${toAssTime(Math.min(duration, rows[i+1]?.start ?? duration))},Default,,0,0,0,,${r.text}`).join('\n');
  return header + events + '\n';
}
function dimensions(aspect, quality) {
  const h = Number(quality) === 720 ? 720 : 1080;
  if (aspect === '9:16') return { w: Math.round(h * 9 / 16 / 2) * 2, h };
  if (aspect === '1:1') return { w: h, h };
  return { w: Math.round(h * 16 / 9 / 2) * 2, h };
}
function getStyleFilter(style, w, h, fps, color) {
  const colors = color === 'gold' ? '0xffc66d' : color === 'rose' ? '0xff638f' : color === 'ice' ? '0xb2e8ff' : '0x42d9ff|0xfa36c8';
  const size = `${w}x${Math.max(160, Math.round(h * 0.32))}`;
  const s = String(style || 'bars').toLowerCase();
  if (['wave','dualwave','heartbeat','ribbon','flame'].includes(s)) return `showwaves=s=${size}:mode=${s === 'heartbeat' ? 'cline' : s === 'wave' ? 'p2p' : 'cline'}:colors=${colors}:r=${fps}:scale=sqrt,format=rgba,colorkey=black:0.10:0.05`;
  const mode = ['dots','particles','constellation','petals','spiral'].includes(s) ? 'dot' : ['circle','radial','arcs','rings','orb','pulse','tunnel'].includes(s) ? 'line' : 'bar';
  return `showfreqs=s=${size}:mode=${mode}:ascale=log:fscale=log:win_size=2048:colors=${colors}:rate=${fps},format=rgba,colorkey=black:0.10:0.05`;
}
function drawTextFilter(text, fontsize, y, fontfile) {
  if (!text) return '';
  const escaped = String(text).replace(/\\/g,'\\\\').replace(/:/g,'\\:').replace(/'/g,"\\'").replace(/%/g,'\\%').replace(/\n/g,' ');
  return `drawtext=fontfile=${fontfile}:text='${escaped}':fontcolor=white:fontsize=${fontsize}:borderw=2:bordercolor=black@0.65:x=(w-text_w)/2:y=${y}`;
}

async function runRender(job) {
  activeJob = true;
  job.status = 'processing'; job.message = 'Preparing audio and video'; job.progress = 1;
  const opts = job.options;
  const probe = await execFileAsync('ffprobe', ['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1', job.audioPath], { timeout: 30000 });
  const duration = Number.parseFloat(probe.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Could not read the audio duration. Try an MP3 or WAV file.');
  if (duration > MAX_DURATION_SECONDS) throw new Error(`Audio is ${Math.ceil(duration/60)} minutes long. The current free server limit is ${Math.floor(MAX_DURATION_SECONDS/60)} minutes.`);
  job.duration = duration;
  const { w, h } = dimensions(opts.aspectRatio, opts.quality);
  const fps = [24,30].includes(Number(opts.fps)) ? Number(opts.fps) : 24;
  const bitrate = [3000000,5000000,8000000].includes(Number(opts.bitrate)) ? Number(opts.bitrate) : 5000000;
  const color = opts.theme || 'aurora';
  const audioPath = job.audioPath;
  const coverPath = job.coverPath;
  const subtitlePath = path.join(job.dir, 'lyrics.ass');
  if (opts.lyrics && String(opts.lyrics).trim()) {
    fs.writeFileSync(subtitlePath, createAss(opts.lyrics, duration, w, h, opts), 'utf8'); job.subtitlePath = subtitlePath;
  }
  const output = job.outputPath;
  const inputs = ['-hide_banner','-y','-i',audioPath];
  if (coverPath) inputs.push('-loop','1','-framerate',String(fps),'-i',coverPath);
  else inputs.push('-f','lavfi','-i',`color=c=0x080b14:s=${w}x${h}:r=${fps}:d=${duration}`);
  const wave = getStyleFilter(opts.style, w, h, fps, color);
  const bgInput = '[1:v]';
  const filters = [`${bgInput}scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps}[bg]`,
    `[0:a]${wave}[viz]`, `[bg][viz]overlay=(W-w)/2:(H-h)/2:shortest=1[base]`];
  let current = '[base]';
  const fontfile = '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf';
  if (opts.title) { filters.push(`${current}${drawTextFilter(opts.title, Math.round(w * (opts.titleSize === 'large' ? 0.055 : opts.titleSize === 'small' ? 0.028 : 0.04)), Math.round(h * 0.12), fontfile)}[titled]`); current='[titled]'; }
  if (opts.subtitle) { filters.push(`${current}${drawTextFilter(opts.subtitle, Math.round(w * 0.022), Math.round(h * 0.19), fontfile)}[subtitled]`); current='[subtitled]'; }
  if (opts.watermark !== 'off') { filters.push(`${current}${drawTextFilter('SAUT', Math.round(w * 0.025), `h-text_h-${Math.round(h*0.045)}`, fontfile)}[marked]`); current='[marked]'; }
  if (job.subtitlePath) { const escaped = subtitlePath.replace(/\\/g,'/').replace(/:/g,'\\:').replace(/'/g,"\\'"); filters.push(`${current}subtitles='${escaped}'[lyriced]`); current='[lyriced]'; }
  filters.push(`${current}format=yuv420p[outv]`);
  const args = [...inputs, '-filter_complex', filters.join(';'), '-map','[outv]','-map','0:a:0','-c:v','libx264','-preset','veryfast','-crf','18','-b:v',String(bitrate),'-maxrate',String(bitrate),'-bufsize',String(bitrate*2),'-pix_fmt','yuv420p','-r',String(fps),'-c:a','aac','-b:a','192k','-movflags','+faststart','-t',String(duration),'-progress','pipe:1','-nostats',output];
  job.message = 'Rendering MP4 frames with FFmpeg';
  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore','pipe','pipe'] });
    job.process = proc;
    let stderr = '';
    proc.stdout.setEncoding('utf8');
    let stdoutBuffer = '';
    proc.stdout.on('data', chunk => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/); stdoutBuffer = lines.pop();
      for (const line of lines) {
        const [key, value] = line.split('=');
        if (key === 'out_time_ms') { const sec = Number(value) / 1000000; job.progress = Math.max(2, Math.min(98, Math.floor(sec / duration * 100))); job.message = `Rendering video · ${Math.floor(sec)} of ${Math.ceil(duration)} seconds`; }
        if (key === 'progress' && value === 'end') job.progress = 99;
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
    proc.on('error', reject);
    proc.on('close', code => { job.process = null; if (code === 0 && fs.existsSync(output) && fs.statSync(output).size > 1000) resolve(); else reject(new Error((stderr.match(/\n[^\n]*(?:Error|Invalid|failed)[^\n]*/i) || [])[0]?.trim() || `FFmpeg exited with code ${code}. Try a shorter audio file or lower resolution.`)); });
  });
  job.outputBytes = fs.statSync(output).size;
  job.status = 'completed'; job.progress = 100; job.message = 'MP4 render complete'; job.finishedAt = new Date().toISOString();
}

async function worker(job) {
  try { await runRender(job); }
  catch (err) { job.status = 'failed'; job.error = String(err.message || err).slice(0, 1200); job.message = 'Rendering failed'; job.finishedAt = new Date().toISOString(); }
  finally { activeJob = false; if (job.audioPath) { try { fs.unlinkSync(job.audioPath); } catch {} job.audioPath = null; } if (job.coverPath) { try { fs.unlinkSync(job.coverPath); } catch {} job.coverPath = null; } }
}
app.get('/api/health', (_req,res) => res.json({ ok:true, service:'saut-ffmpeg-renderer', ffmpeg:true, maxUploadMB:MAX_UPLOAD_MB, maxDurationSeconds:MAX_DURATION_SECONDS, queueAvailable:!activeJob }));
app.post('/api/render', upload.fields([{name:'audio',maxCount:1},{name:'cover',maxCount:1}]), (req,res) => {
  const audio = req.files?.audio?.[0]; const cover = req.files?.cover?.[0];
  if (!audio) { if (cover) fs.unlink(cover.path,()=>{}); return res.status(400).json({ error:'Choose an audio file from your device first.' }); }
  if (activeJob) { fs.unlink(audio.path,()=>{}); if (cover) fs.unlink(cover.path,()=>{}); return res.status(429).json({ error:'The free renderer is processing another video. Wait for that job to finish, then try again.' }); }
  if (jobs.size >= MAX_JOBS_IN_MEMORY) {
    for (const [id,j] of jobs) if (['completed','failed'].includes(j.status)) { cleanJobFiles(j); jobs.delete(id); if (jobs.size < MAX_JOBS_IN_MEMORY) break; }
  }
  const id = crypto.randomUUID(); const dir = path.join(tmpRoot,id); fs.mkdirSync(dir,{recursive:true});
  const audioPath = path.join(dir, 'source' + (path.extname(audio.originalname).toLowerCase().replace(/[^.a-z0-9]/g,'') || '.audio'));
  fs.renameSync(audio.path,audioPath);
  let coverPath = null;
  if (cover) { coverPath = path.join(dir,'cover' + (path.extname(cover.originalname).toLowerCase().replace(/[^.a-z0-9]/g,'') || '.img')); fs.renameSync(cover.path,coverPath); }
  const pick = (v, fallback, max=200) => String(v ?? fallback).slice(0,max);
  const opts = { aspectRatio: ['16:9','9:16','1:1'].includes(req.body.aspectRatio) ? req.body.aspectRatio : '16:9', quality: Number(req.body.quality) === 720 ? 720 : 1080,
    fps: Number(req.body.fps), bitrate: Number(req.body.bitrate), style: pick(req.body.style,'bars',40), theme: pick(req.body.theme,'aurora',20), title: pick(req.body.title,'',120), subtitle: pick(req.body.subtitle,'',120), titleSize: pick(req.body.titleSize,'medium',20), watermark: req.body.watermark === 'off' ? 'off' : 'on', lyrics: pick(req.body.lyrics,'',30000), lyricSize: Number(req.body.lyricSize) || 30, lyricPosition: pick(req.body.lyricPosition,'bottom',20), lyricFont: pick(req.body.lyricFont,'naskh',20) };
  const job = { id, dir, audioPath, coverPath, subtitlePath:null, outputPath:path.join(dir,'saut-render.mp4'), status:'queued', progress:0, message:'Waiting for renderer', createdAt:new Date().toISOString(), options:opts };
  jobs.set(id,job); res.status(202).json(publicJob(job)); worker(job);
});
app.get('/api/jobs/:id', (req,res) => { const j=jobs.get(req.params.id); if (!j) return res.status(404).json({error:'Render job not found. The free server may have restarted; please submit it again.'}); res.json(publicJob(j)); });
app.get('/api/jobs/:id/download', (req,res) => { const j=jobs.get(req.params.id); if (!j || j.status !== 'completed' || !fs.existsSync(j.outputPath)) return res.status(404).json({error:'The rendered file is no longer available. Free-tier storage is temporary; render it again.'}); res.download(j.outputPath, 'saut-visualizer.mp4'); });
app.delete('/api/jobs/:id', (req,res) => { const j=jobs.get(req.params.id); if (!j) return res.status(404).json({error:'Job not found'}); if (j.process) { try { j.process.kill('SIGTERM'); } catch {} } cleanJobFiles(j); jobs.delete(j.id); res.json({ok:true}); });
app.use((err, _req, res, _next) => { const status = err instanceof multer.MulterError ? (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400) : 400; res.status(status).json({ error: err.message || 'Request failed.' }); });
app.listen(PORT, () => console.log(`Saut FFmpeg renderer listening on ${PORT}`));
       
