#!/usr/bin/env node
/**
 * download-convert.mjs — task T2 of the gymbro exercise-media cascade (spec S3).
 *
 * Downloads the source asset named for every entry of manifest.json and writes the
 * converted media into the catalogue's normal locations:
 *
 *   catalogue/media/still/<id>.webp   always
 *   catalogue/media/clip/<id>.mp4     only for kind "still+clip"
 *
 * Target conventions are the ones the repository already uses (probed before this run):
 *   still: WebP, 180x180, VP8L lossless, opaque white canvas
 *   clip : H.264 High@1.2, yuv420p, 180x180, 10 fps, 2-5 s, faststart
 *
 * Fitting rule (one rule for every source, documented in convert-report.json):
 *   scale-to-fit inside the 180x180 box, then letterbox the remainder with white —
 *   never crop. The catalogue's stills are white canvases, so the letterbox matches
 *   the surrounding files instead of introducing a second background colour.
 *
 * workout-guide draws white line art on a transparent/black canvas: its frames are
 * negated (white art -> black art) and then letterboxed onto white, which is what the
 * rest of the catalogue looks like. The three SVG frames are cycled 1-2-3 at 10 fps
 * to a 3.0 s clip, the same length and frame rate as the existing clips.
 *
 * Resumability: convert-report.json records a SHA-256 for every file this script wrote.
 * An entry whose recorded files are still on disk with the same hashes is skipped, so a
 * restarted run never re-downloads finished work — and, crucially, never mistakes a
 * pre-existing Gym visual file for finished work (those have no record here).
 *
 * Downloads are grouped per host, connection-reused by the global fetch dispatcher,
 * paced (>=200 ms between request starts) and retried with exponential backoff.
 * Sources live in a temp cache outside the repository; failures are recorded per entry
 * and never abort the run.
 *
 * Usage: node scripts/media-cascade/download-convert.mjs [--limit N] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const MANIFEST_FILE = path.join(HERE, 'manifest.json');
const REPORT_FILE = path.join(HERE, 'convert-report.json');
const STILL_DIR = path.join(REPO, 'catalogue', 'media', 'still');
const CLIP_DIR = path.join(REPO, 'catalogue', 'media', 'clip');

// Temp downloads and intermediates never touch the repository.
const CACHE_ROOT = process.env.MEDIA_CACHE
  ?? 'C:/Users/Usuario/AppData/Local/Temp/opencode/media-cache';
const SRC_DIR = path.join(CACHE_ROOT, 'src');
const WORK_DIR = path.join(CACHE_ROOT, 'work');

const TARGET = 180;
const CLIP_FPS = 10;
const CLIP_MAX_S = 5;
const WG_RENDER_PX = 720; // SVGs are drawn at 4x and downscaled, never upscaled
const WG_CLIP_FRAMES = 30; // 3 frames cycled at 10 fps -> 3.0 s, like the existing clips

const FIT = `scale=${TARGET}:${TARGET}:force_original_aspect_ratio=decrease,`
  + `pad=${TARGET}:${TARGET}:(ow-iw)/2:(oh-ih)/2:color=white`;
const STILL_VF = `${FIT},format=rgb24`;
const CLIP_VF = `fps=${CLIP_FPS},${FIT},format=yuv420p`;
const X264 = ['-c:v', 'libx264', '-profile:v', 'high', '-level:v', '1.2',
  '-preset', 'medium', '-crf', '22', '-movflags', '+faststart'];
const WEBP = ['-c:v', 'libwebp', '-lossless', '1', '-compression_level', '6'];

const UA = 'opencode-gymbro-media-cascade/1.0 (download-convert)';
const HOST_RULES = {
  'raw.githubusercontent.com': { concurrency: 4, paceMs: 200 },
  'huggingface.co': { concurrency: 3, paceMs: 300 },
};
const MAX_ATTEMPTS = 4;
const REPORT_EVERY = 20;

const args = process.argv.slice(2);
const LIMIT = Number(args[args.indexOf('--limit') + 1]) || 0;
const DRY_RUN = args.includes('--dry-run');

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const shaFile = (p) => sha(fs.readFileSync(p));

function atomicWrite(target, buf) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, target);
}

function runCapture(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out)
      : reject(new Error(`${cmd} exited ${code}: ${err.slice(-800)}`))));
  });
}
const ffmpeg = (ffmpegArgs) => runCapture('ffmpeg', ['-y', '-v', 'error', ...ffmpegArgs]);

async function probe(file) {
  const out = await runCapture('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,profile,level,width,height,r_frame_rate,pix_fmt,nb_frames',
    '-show_entries', 'format=duration', '-of', 'json', file]);
  const j = JSON.parse(out);
  const s = j.streams?.[0];
  if (!s) throw new Error(`no video stream in ${file}`);
  const [num, den] = String(s.r_frame_rate ?? '0/1').split('/').map(Number);
  return {
    codec: s.codec_name,
    profile: s.profile ?? null,
    level: s.level ?? null,
    width: s.width,
    height: s.height,
    pixFmt: s.pix_fmt ?? null,
    fps: den ? num / den : null,
    frames: s.nb_frames ? Number(s.nb_frames) : null,
    durationS: Number(j.format?.duration ?? 0) || null,
  };
}

function fileInfo(p) {
  const st = fs.statSync(p);
  return { path: path.relative(REPO, p).replace(/\\/g, '/'), bytes: st.size, sha256: shaFile(p), mtime: st.mtime.toISOString() };
}

// ---------------------------------------------------------------------------
// Per-host pacing + concurrency gate
// ---------------------------------------------------------------------------
function makeGate({ concurrency, paceMs }) {
  let active = 0;
  let nextStart = 0;
  const queue = [];
  const pump = () => {
    while (active < concurrency && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      const now = Date.now();
      const wait = Math.max(0, nextStart - now);
      nextStart = now + wait + paceMs;
      active += 1;
      setTimeout(() => {
        Promise.resolve().then(fn).then(resolve, reject)
          .finally(() => { active -= 1; pump(); });
      }, wait);
    }
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}

const gates = new Map();
function gateFor(url) {
  const host = new URL(url).host;
  if (!gates.has(host)) {
    gates.set(host, makeGate(HOST_RULES[host] ?? { concurrency: 4, paceMs: 200 }));
  }
  return gates.get(host);
}

const stats = { downloads: 0, cacheHits: 0, downloadBytes: 0, ffmpegCalls: 0 };

async function fetchBuffer(url) {
  const gate = gateFor(url);
  let lastError = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(800 * 2 ** (attempt - 1) + Math.random() * 400);
    try {
      return await gate(async () => {
        const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          stats.downloads += 1;
          stats.downloadBytes += buf.length;
          return buf;
        }
        const permanent = [404, 410, 403, 400].includes(res.status);
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.permanent = permanent;
        err.retryAfter = Number(res.headers.get('retry-after')) || 0;
        throw err;
      });
    } catch (err) {
      lastError = err;
      if (err?.permanent) throw err;
      if (err?.retryAfter) await sleep(Math.min(30_000, err.retryAfter * 1000));
    }
  }
  throw lastError ?? new Error(`download failed: ${url}`);
}

function cachePathFor(url) {
  const u = new URL(url);
  const ext = path.extname(u.pathname).toLowerCase() || '.bin';
  return path.join(SRC_DIR, crypto.createHash('sha1').update(url).digest('hex') + ext);
}

async function download(url) {
  const p = cachePathFor(url);
  if (fs.existsSync(p) && fs.statSync(p).size > 0) { stats.cacheHits += 1; return p; }
  const buf = await fetchBuffer(url);
  fs.mkdirSync(SRC_DIR, { recursive: true });
  const tmp = `${p}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, p);
  return p;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------
async function stillFromMedia(src, out) {
  stats.ffmpegCalls += 1;
  await ffmpeg(['-i', src, '-vf', STILL_VF, '-frames:v', '1', ...WEBP, out]);
}

async function clipFromMedia(src, out) {
  stats.ffmpegCalls += 1;
  await ffmpeg(['-i', src, '-t', String(CLIP_MAX_S), '-vf', CLIP_VF, ...X264, out]);
}

async function renderSvg(svgPath, outPng) {
  const svg = fs.readFileSync(svgPath, 'utf8');
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: WG_RENDER_PX },
    background: '#000000',
  }).render().asPng();
  fs.writeFileSync(outPng, png);
}

/** 3 SVG frames -> negated, letterboxed still (frame 1) + 3.0 s looping clip. */
async function convertWorkoutGuide(svgPaths, dir) {
  const frames = [];
  for (let i = 0; i < 3; i++) {
    const p = path.join(dir, `frame-${i + 1}.png`);
    await renderSvg(svgPaths[i], p);
    frames.push(p);
  }
  // Ping-pong-free straight loop: 1,2,3,2 | 1,2,3,2 ... so the clip reads as a cycle
  // at the same cadence the GIF-sourced clips use.
  const order = [0, 1, 2, 1];
  const lines = [];
  for (let i = 0; i < WG_CLIP_FRAMES; i++) {
    lines.push(`file '${frames[order[i % 4]].replace(/\\/g, '/')}'`, 'duration 0.1');
  }
  const list = path.join(dir, 'frames.txt');
  fs.writeFileSync(list, `${lines.join('\n')}\n`, 'utf8');

  const clipOut = path.join(dir, 'clip.mp4');
  stats.ffmpegCalls += 1;
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list,
    '-vf', `negate,${FIT},format=yuv420p`, '-r', String(CLIP_FPS), ...X264, clipOut]);

  const stillOut = path.join(dir, 'still.webp');
  stats.ffmpegCalls += 1;
  await ffmpeg(['-i', frames[0], '-vf', `negate,${STILL_VF}`, '-frames:v', '1', ...WEBP, stillOut]);
  return { stillOut, clipOut };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
const report = fs.existsSync(REPORT_FILE)
  ? JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'))
  : {
    tool: 'scripts/media-cascade/download-convert.mjs',
    manifest: 'scripts/media-cascade/manifest.json',
    generatedAt: new Date().toISOString(),
    target: {
      still: 'WebP 180x180, VP8L lossless, opaque white canvas',
      clip: 'H.264 High@1.2, yuv420p, 180x180, 10 fps, <=5 s, faststart',
      fitting: 'scale-to-fit inside 180x180, letterboxed with white, never cropped',
      workoutGuide: '3 SVG frames negated (white art -> black art), cycled 1-2-3-2 at 10 fps to 3.0 s',
    },
    entries: {},
    failures: [],
    lastRun: null,
  };
report.entries ??= {};
report.failures ??= [];

function writeReport() {
  const summary = summarise();
  report.generatedAt = new Date().toISOString();
  report.summary = summary;
  const tmp = `${REPORT_FILE}.part`;
  fs.writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, REPORT_FILE);
}

function summarise() {
  const bySource = {};
  const s = { attempted: manifest.entries.length, ok: 0, partial: 0, failed: 0, notAttempted: 0,
    stillWritten: 0, clipsWritten: 0, staleClipsRemoved: 0, bytesOnDisk: 0 };
  for (const e of manifest.entries) {
    const r = report.entries[e.id];
    const bucket = (bySource[e.source] ??= { ok: 0, partial: 0, failed: 0, notAttempted: 0 });
    if (!r || !r.status) { s.notAttempted += 1; bucket.notAttempted += 1; continue; }
    s[r.status] += 1;
    bucket[r.status] += 1;
    if (r.still) { s.stillWritten += 1; s.bytesOnDisk += r.still.bytes; }
    if (r.clip) { s.clipsWritten += 1; s.bytesOnDisk += r.clip.bytes; }
    if (r.removedClip) s.staleClipsRemoved += 1;
  }
  s.bySource = bySource;
  s.bytesOnDisk = Number(s.bytesOnDisk.toFixed(0));
  return s;
}

// ---------------------------------------------------------------------------
// Placing outputs
// ---------------------------------------------------------------------------
function placeEntry(entry, outputs, status, error) {
  const stillPath = path.join(STILL_DIR, `${entry.id}.webp`);
  const clipPath = path.join(CLIP_DIR, `${entry.id}.mp4`);
  const rec = report.entries[entry.id] ?? {
    id: entry.id,
    name: entry.name,
    source: entry.source,
    sourceRef: entry.sourceRef,
    sourceAsset: entry.sourceAsset,
    kind: entry.kind,
    licence: entry.licence,
    producedBy: 'gymbro-media-cascade',
  };

  if (status !== 'ok') {
    rec.status = status;
    rec.error = String(error ?? 'unknown error');
    rec.at = new Date().toISOString();
    report.entries[entry.id] = rec;
    report.failures.push({ id: entry.id, source: entry.source, sourceAsset: entry.sourceAsset,
      error: rec.error, at: rec.at });
    return;
  }

  // Remember the file we are about to replace only if it is not already ours.
  const prevStill = fs.existsSync(stillPath) ? fileInfo(stillPath) : null;
  if (prevStill && rec.still?.sha256 !== prevStill.sha256) rec.replacedStill = prevStill;

  atomicWrite(stillPath, outputs.still);
  rec.still = {
    path: path.relative(REPO, stillPath).replace(/\\/g, '/'),
    bytes: outputs.still.length,
    sha256: outputs.stillSha,
    mtime: fs.statSync(stillPath).mtime.toISOString(),
    ...outputs.stillMeta,
  };

  if (entry.kind === 'still+clip') {
    const prevClip = fs.existsSync(clipPath) ? fileInfo(clipPath) : null;
    if (prevClip && rec.clip?.sha256 !== prevClip.sha256) rec.replacedClip = prevClip;
    atomicWrite(clipPath, outputs.clip);
    rec.clip = {
      path: path.relative(REPO, clipPath).replace(/\\/g, '/'),
      bytes: outputs.clip.length,
      sha256: outputs.clipSha,
      mtime: fs.statSync(clipPath).mtime.toISOString(),
      ...outputs.clipMeta,
    };
    delete rec.removedClip;
  } else if (fs.existsSync(clipPath)) {
    // Our still plus Gym visual's clip would mix two licences on one exercise.
    rec.removedClip = { ...fileInfo(clipPath), reason: 'still-only source: a Gym visual clip beside our still mixes licences' };
    fs.unlinkSync(clipPath);
    delete rec.clip;
  }

  rec.status = 'ok';
  rec.error = null;
  rec.at = new Date().toISOString();
  report.entries[entry.id] = rec;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
function buildJobs(entries) {
  const wgFrames = new Map(); // sourceRef -> [url, url, url]
  const jobs = [];
  const byKey = new Map();

  for (const entry of entries) {
    let key, urls;
    if (entry.source === 'workout-guide') {
      key = `workout-guide|${entry.sourceRef}`;
      const frames = wgFrames.get(entry.sourceRef);
      if (frames) urls = frames;
      else { wgFrames.set(entry.sourceRef, null); urls = null; } // filled after the manifest fetch
    } else {
      key = `${entry.source}|${entry.sourceAsset}`;
      urls = [entry.sourceAsset];
    }
    let job = byKey.get(key);
    if (!job) {
      job = { key, source: entry.source, kind: entry.kind, urls, entries: [] };
      byKey.set(key, job);
      jobs.push(job);
    }
    job.entries.push(entry);
  }
  return { jobs, wgRefs: [...wgFrames.keys()] };
}

async function fetchWorkoutGuideFrames(refs) {
  if (!refs.length) return new Map();
  const base = 'https://raw.githubusercontent.com/bryllim/workout-guide/main/packages/workout-guide/';
  const list = JSON.parse(await (await fetchBuffer(base + 'manifest.json')).toString('utf8'));
  const byId = new Map(list.map((r) => [r.id, r]));
  return new Map(refs.map((ref) => {
    const record = byId.get(ref);
    const paths = (record?.frames ?? []).slice(0, 3).map((f) => f.path);
    return [ref, paths.length === 3 ? paths.map((p) => base + p) : null];
  }));
}

async function processJob(job, frameMap) {
  const dir = path.join(WORK_DIR, crypto.createHash('sha1').update(job.key).digest('hex').slice(0, 16));
  fs.mkdirSync(dir, { recursive: true });
  try {
    let urls = job.urls;
    if (job.source === 'workout-guide') {
      urls = frameMap?.get(job.key.split('|')[1]);
      if (!urls) throw new Error('workout-guide manifest has no 3-frame entry for this id');
    }
    const sources = [];
    for (const url of urls) sources.push(await download(url));

    let stillBuf, clipBuf, stillMeta, clipMeta;
    if (job.source === 'workout-guide') {
      const { stillOut, clipOut } = await convertWorkoutGuide(sources, dir);
      stillBuf = fs.readFileSync(stillOut);
      clipBuf = fs.readFileSync(clipOut);
      stillMeta = await probe(stillOut);
      clipMeta = await probe(clipOut);
    } else {
      const stillOut = path.join(dir, 'still.webp');
      await stillFromMedia(sources[0], stillOut);
      stillBuf = fs.readFileSync(stillOut);
      stillMeta = await probe(stillOut);
      if (job.kind === 'still+clip') {
        const clipOut = path.join(dir, 'clip.mp4');
        await clipFromMedia(sources[0], clipOut);
        clipBuf = fs.readFileSync(clipOut);
        clipMeta = await probe(clipOut);
      }
    }
    if (!stillBuf?.length) throw new Error('empty still output');
    if (job.kind === 'still+clip' && !clipBuf?.length) throw new Error('empty clip output');

    const outputs = {
      still: stillBuf, stillSha: sha(stillBuf), stillMeta,
      clip: clipBuf, clipSha: clipBuf ? sha(clipBuf) : null, clipMeta,
    };
    for (const entry of job.entries) placeEntry(entry, outputs, 'ok');
    return { ok: job.entries.length, failed: 0 };
  } catch (err) {
    for (const entry of job.entries) placeEntry(entry, null, 'failed', err.message);
    return { ok: 0, failed: job.entries.length, error: err.message };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
function pendingEntries() {
  const done = (entry) => {
    const r = report.entries[entry.id];
    if (!r || r.status !== 'ok') return false;
    const stillOk = r.still && fs.existsSync(path.join(REPO, r.still.path))
      && fs.statSync(path.join(REPO, r.still.path)).size === r.still.bytes
      && shaFile(path.join(REPO, r.still.path)) === r.still.sha256;
    if (!stillOk) return false;
    if (entry.kind === 'still+clip') {
      return Boolean(r.clip) && fs.existsSync(path.join(REPO, r.clip.path))
        && fs.statSync(path.join(REPO, r.clip.path)).size === r.clip.bytes
        && shaFile(path.join(REPO, r.clip.path)) === r.clip.sha256;
    }
    // still-only: no clip of ours may exist, and no foreign clip may survive
    return !fs.existsSync(path.join(CLIP_DIR, `${entry.id}.mp4`));
  };
  return manifest.entries.filter((e) => !done(e));
}

async function runPool(items, limit, worker) {
  let cursor = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
}

async function main() {
  fs.mkdirSync(SRC_DIR, { recursive: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(STILL_DIR, { recursive: true });
  fs.mkdirSync(CLIP_DIR, { recursive: true });

  const pending = pendingEntries();
  console.log(`manifest entries ${manifest.entries.length}, pending ${pending.length}, already ours ${manifest.entries.length - pending.length}`);
  // A failed id is retried on this run, so drop its stale failure record first.
  const pendingIds = new Set(pending.map((e) => e.id));
  report.failures = report.failures.filter((f) => !pendingIds.has(f.id));

  const { jobs, wgRefs } = buildJobs(pending);
  const frameMap = await fetchWorkoutGuideFrames(wgRefs).catch((err) => {
    console.error(`workout-guide manifest fetch failed: ${err.message}`);
    return new Map();
  });
  const runnable = DRY_RUN ? [] : (LIMIT ? jobs.slice(0, LIMIT) : jobs);
  const hosts = [...new Set(pending.map((e) => {
    try { return new URL(e.sourceAsset).host; } catch { return '?'; }
  }))];
  console.log(`jobs ${jobs.length} (${runnable.length} to run now), hosts: ${hosts.join(', ')}`);

  if (DRY_RUN) {
    for (const j of jobs.slice(0, 20)) console.log(`  ${j.key} -> ${j.entries.length} entries`);
    return;
  }

  const startedAt = new Date().toISOString();
  let processed = 0, okEntries = 0, failedEntries = 0;
  const t0 = Date.now();
  await runPool(runnable, Object.values(HOST_RULES).reduce((a, r) => a + r.concurrency, 0), async (job) => {
    const res = await processJob(job, frameMap);
    processed += 1;
    okEntries += res.ok;
    failedEntries += res.failed;
    if (res.error) console.error(`  FAIL ${job.key}: ${res.error}`);
    if (processed % REPORT_EVERY === 0) {
      writeReport();
      const rate = processed / ((Date.now() - t0) / 1000);
      const eta = rate ? Math.round((runnable.length - processed) / rate) : 0;
      console.log(`  ${processed}/${runnable.length} jobs, ${okEntries} entries ok, `
        + `${failedEntries} failed, ${stats.downloads} downloads, ETA ${eta}s`);
    }
  });

  report.lastRun = {
    startedAt,
    finishedAt: new Date().toISOString(),
    jobsProcessed: processed,
    entriesOk: okEntries,
    entriesFailed: failedEntries,
    downloads: stats.downloads,
    cacheHits: stats.cacheHits,
    downloadBytes: stats.downloadBytes,
    ffmpegCalls: stats.ffmpegCalls,
  };
  writeReport();

  const s = summarise();
  console.log('\n=== download-convert summary ===');
  console.log(`attempted ${s.attempted}  ok ${s.ok}  partial ${s.partial}  failed ${s.failed}  not attempted ${s.notAttempted}`);
  console.log(`stills written ${s.stillWritten}  clips written ${s.clipsWritten}  stale clips removed ${s.staleClipsRemoved}`);
  console.log(`bytes of our media on disk ${s.bytesOnDisk}`);
  console.log(`by source ${JSON.stringify(s.bySource)}`);
  if (s.failed) {
    console.log('failures:');
    for (const f of report.failures.slice(-40)) console.log(`  ${f.id} [${f.source}] ${f.error}`);
  }
  if (runnable.length < jobs.length) console.log(`note: --limit left ${jobs.length - runnable.length} jobs for the next run`);
}

await main();
