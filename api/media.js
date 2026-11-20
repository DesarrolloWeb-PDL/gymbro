/* Photos, GIFs and videos of a person's own exercises: the server half.
 *
 * A custom exercise in the state carries a MediaRef (sha256, kind, mime, size, dimensions, a
 * poster ref) and never the bytes. The bytes live here, per profile and named by their hash:
 *
 *   DATA_DIR/uploads/<uid>/<sha256>.<ext>     0700 directories, 0600 files
 *   DATA_DIR/uploads/<uid>/.gc.json           { hash: unreferencedSinceMs }
 *   DATA_DIR/uploads/<uid>/.tmp/<random>      uploads in flight; never outlive their request
 *
 * With MEDIA_BACKEND=blob (the Vercel deployment) only the third of those survives. The bytes go
 * to Blob as `uploads/<uid>/<sha256>.<ext>` and the metadata — sizes, quota, and the grace marks
 * .gc.json used to carry — becomes rows in the `media` table, read through the one query handle
 * storage.js exports. The staging directory stays local either way: the hash check, the magic sniff
 * and the MP4 box walk all need positioned reads on local bytes, and a bad hash has to be refused
 * before anything durable is written. What Blob cannot answer — free disk space — is exactly why
 * the 507 floor below is scoped to that staging directory and not to Blob.
 *
 * What this module promises, and why each promise is shaped the way it is:
 *
 * - It never decodes media. The only bytes it interprets are the first 64 (magic numbers) and,
 *   for MP4/MOV, the box headers down to mvhd. No image library means no decompression bomb,
 *   no codec parser and no dependency; the metadata scrub and re-encode happen on the device
 *   that picked the file.
 * - It never buffers an upload. The production API runs with a 128 MB memory limit and a video
 *   may be 40 MB, so bytes go from the socket through a hash to a temp file and nowhere else.
 * - It never deletes because something is missing. A state file that cannot be read, a user
 *   that is not in db.json (a db.json that failed to parse boots with no users at all) and an
 *   unreadable .gc.json all mean "keep everything". Blobs only go when the profile's own
 *   readable state has not referenced them for the whole grace period, or when the profile
 *   itself is deleted. Devices that still hold a blob the server dropped upload it again.
 * - The directory is the access check. Nothing here takes a uid from a request; every lookup
 *   is in the caller's own folder, so there is no way to learn whether someone else has a file.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { syncDir, syncFile } from './durable.js';
import { query, queryAvailable } from './storage.js';
import { MEDIA_BACKEND, blobPathname, createBlobBytes } from './storage-blob.js';

// MEDIA_BACKEND=blob keeps upload metadata in the `media` table, so it needs the one query handle
// storage.js exports — which only the postgres driver has. Refusing here is the same boot error an
// unknown STORAGE_DRIVER gives: better not to start than to start believing the uploads are in
// Blob while nothing can read them back. An unknown name already threw inside storage-blob.js.
if (MEDIA_BACKEND === 'blob' && !queryAvailable) {
  throw new Error('MEDIA_BACKEND=blob needs STORAGE_DRIVER=postgres: upload metadata lives in the media table, and the fs storage driver has no SQL query handle');
}

export const HASH_RE = /^[0-9a-f]{64}$/;
const MB = 1024 * 1024;          // every *_MB setting means MiB; the client uses the same unit
const HOUR = 3600000;
const DAY = 24 * HOUR;
const HEAD_BYTES = 64;            // enough for every magic number below, the WebM DocType included
const MOOV_MAX = 8 * MB;          // a real moov for a 60 s clip is well under 1 MB
const MAX_BOXES = 10000;
export const MAX_INFLIGHT = 2;    // concurrent uploads per profile

/* The eight types that are ever stored. `category` is what the client may not lie about: a
   JPEG declared as a GIF is still a still image and is stored as the JPEG it is, but a video
   declared as an image would slip past the image cap, so that mismatch is refused. */
export const MEDIA_TYPES = {
  'image/jpeg': { kind: 'image', category: 'still', ext: 'jpg' },
  'image/png': { kind: 'image', category: 'still', ext: 'png' },
  'image/webp': { kind: 'image', category: 'still', ext: 'webp' },
  'image/gif': { kind: 'gif', category: 'still', ext: 'gif' },
  'video/mp4': { kind: 'video', category: 'video', ext: 'mp4' },
  'video/quicktime': { kind: 'video', category: 'video', ext: 'mov' },
  'video/webm': { kind: 'video', category: 'video', ext: 'webm' },
  // A sound of the user's own for the rest timer (v1.4.5): always the 16-bit PCM WAV the app wrote
  // from what was picked (frontend lib/sound-ingest.js), at most 30 s.
  'audio/wav': { kind: 'audio', category: 'audio', ext: 'wav' }
};
const EXT_MIME = Object.fromEntries(Object.entries(MEDIA_TYPES).map(([mime, t]) => [t.ext, mime]));
const FILE_RE = /^([0-9a-f]{64})\.(jpg|png|webp|gif|mp4|mov|webm|wav)$/;

/* ---------------------------------------------------------------- limits */

const OFF = /^(0|false|no|off)$/i;
/** The instance's media settings, read from the environment (docs/SELF_HOSTING.md). Every MB
 *  value is MiB and may be fractional. A value that does not parse falls back to its default
 *  rather than to 0: a typo must not turn the quota off or refuse every upload. */
export function mediaLimits(env = process.env) {
  const num = (key, def, min) => {
    const raw = env[key];
    if (raw == null || String(raw).trim() === '') return def;
    const n = Number(raw);
    return Number.isFinite(n) && n >= min ? n : def;
  };
  return {
    enabled: !OFF.test(String(env.MEDIA_UPLOADS || '').trim()),
    quotaMB: num('MEDIA_QUOTA_MB', 200, 0),              // 0 = no cap
    imageMB: num('MEDIA_IMAGE_MAX_MB', 2, 0.001),
    gifMB: num('MEDIA_GIF_MAX_MB', 8, 0.001),
    videoMB: num('MEDIA_VIDEO_MAX_MB', 100, 0.001),   // v1.4.5: 40 before; the app shrinks big videos first
    videoSec: num('MEDIA_VIDEO_MAX_SEC', 60, 1),
    audioMB: num('MEDIA_AUDIO_MAX_MB', 2, 0.001),        // a sound of one's own: 30 s of WAV is 1.3 MB
    gcGraceDays: num('MEDIA_GC_GRACE_DAYS', 14, 0),
    uploadsPerHour: Math.floor(num('MEDIA_UPLOADS_PER_HOUR', 600, 1)),
    minFreeMB: num('MEDIA_MIN_FREE_MB', 512, 0)          // 0 = no floor
  };
}
/** The block GET /api/config hands out. Public: the caps are not a secret, and the editor needs
 *  them before the first upload to refuse a file the server would refuse anyway. */
// `workouts: true`: this server keeps the files a logged workout's `media` names (its GC walks
// workouts[].media), so a signed-in client may offer attaching them. A server from before says
// nothing, and the client offers them on custom exercises only.
// `days: true`: it keeps the files of progress photos filed under a day (`dayPhotos`, a photo for
// a day without a workout, #557) too. An older server would sweep those, so the app files a photo
// under a day only where this says so.
// `sets: true`: it keeps the form videos filmed for one set too (workouts[].entries[].sets[].media,
// v1.4.4). An older server would sweep those, so there the app keeps a set's video on the phone
// that filmed it and never uploads it.
// `sounds: true`: it keeps the sounds of one's own for the rest timer (state.sounds, v1.4.5). An
// older server would refuse and sweep them, so there the app keeps them on the device that has them.
// `builtin: true`: it keeps your own photo or video on a built-in exercise too (state.exMedia,
// v1.4.5). An older server would sweep those, so there the app does not offer it when signed in.
// `avatar: true`: it keeps the profile picture (state.avatar.m, v1.4.5). Served like every other
// file, from the caller's own folder only, so nobody else (an admin included) can fetch it. An
// older server would sweep it, so there the picture stays on the device that set it.
export const mediaConfig = l => ({ imageMB: l.imageMB, gifMB: l.gifMB, videoMB: l.videoMB, videoSec: l.videoSec, audioMB: l.audioMB, quotaMB: l.quotaMB, workouts: true, days: true, sets: true, sounds: true, avatar: true, builtin: true });

/* ---------------------------------------------------------------- errors */

const MESSAGES = {
  'bad-request': 'bad request',
  'media-type': 'that file type is not accepted',
  'media-too-large': 'that file is too large',
  'media-quota': 'your space for photos and videos is full',
  'media-invalid': 'that video could not be read',
  'media-too-long': 'that video is too long',
  'media-missing': 'no such file',
  'hash-mismatch': 'the file does not match its name',
  'storage-full': 'the server is running out of disk space',
  busy: 'too many uploads at once, try again in a moment',
  locked: 'too many uploads, try again later',
  timeout: 'the upload stalled'
};
/** A refusal the client caused or can act on. The server's catch-all answers it as
 *  `{error, code, ...extra}` with its status and headers, and does not log it: a refused file
 *  is not a server error, and a stack trace per refusal would bury the real ones. */
export class MediaError extends Error {
  constructor(status, code, extra = {}, headers = undefined) {
    super(MESSAGES[code] || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
    this.headers = headers;
  }
}

/* ---------------------------------------------------------------- sniffing */

const MP4_BRANDS = new Set([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4VP',
  'dash', 'mmp4', 'MSNV', '3gp4', '3gp5', '3gp6', '3g2a'
]);

// An EBML variable-length integer at b[i]. IDs keep their length marker, sizes drop it.
function vint(b, i, keepMarker) {
  if (i >= b.length || b[i] === 0) return null;
  const first = b[i];
  let len = 1;
  while (!(first & (0x80 >> (len - 1)))) len++;
  if (i + len > b.length) return null;
  let v = keepMarker ? first : first & (0xff >> len);
  for (let k = 1; k < len; k++) v = v * 256 + b[i + k];
  return { value: v, len };
}
// The DocType of an EBML header ('webm', 'matroska'), read off the header's children.
function ebmlDocType(b) {
  const hs = vint(b, 4, false);
  if (!hs) return null;
  let i = 4 + hs.len;
  const end = Math.min(b.length, i + hs.value);
  while (i < end) {
    const id = vint(b, i, true);
    const sz = id && vint(b, i + id.len, false);
    if (!sz) return null;
    const body = i + id.len + sz.len;
    if (id.value === 0x4282) {
      if (body + sz.value > b.length) return null;
      return Buffer.from(b.subarray(body, body + sz.value)).toString('latin1').replace(/\0+$/, '');
    }
    i = body + sz.value;
  }
  return null;
}

/**
 * What a file is, from its first bytes alone — never from its name or a declared type.
 * Returns { mime, kind, category, ext } or null. The client's sniffKind() follows the same rules
 * and additionally reads HEIC/AVIF, which it only ever re-encodes; the server refuses them.
 */
export function sniffMedia(head) {
  const b = Buffer.isBuffer(head) ? head : Buffer.from(head || []);
  const as = mime => ({ mime, ...MEDIA_TYPES[mime] });
  const at = (off, ...bytes) => bytes.every((x, i) => b[off + i] === x);
  const ascii = (off, len) => b.length >= off + len ? b.toString('latin1', off, off + len) : '';
  if (at(0, 0xff, 0xd8, 0xff)) return as('image/jpeg');
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return as('image/png');
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return as('image/gif');
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return as('image/webp');
  // A WAV of plain PCM ("fmt " right after the header, format 1): the only sound ever stored.
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return ascii(12, 4) === 'fmt ' && b.length >= 22 && b.readUInt16LE(20) === 1 ? as('audio/wav') : null;
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (brand === 'qt  ') return as('video/quicktime');
    if (MP4_BRANDS.has(brand)) return as('video/mp4');
    return null;       // HEIC/AVIF stills, M4A audio and every brand nobody vouched for
  }
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return ebmlDocType(b) === 'webm' ? as('video/webm') : null;
  return null;
}

/* ---------------------------------------------------------------- MP4 / MOV */

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  return fs.readSync(fd, buf, 0, len, pos) === len ? buf : null;
}
// The box whose header starts at `pos`, which must end by `end`. size 1 = a 64-bit size follows,
// size 0 = the box runs to `end`. Anything that would reach outside its parent is a broken file.
function boxAt(fd, pos, end) {
  if (end - pos < 8) return null;
  const h = readAt(fd, pos, Math.min(16, end - pos));
  if (!h) return null;
  let size = h.readUInt32BE(0);
  let headerLen = 8;
  if (size === 1) {
    if (h.length < 16) return null;
    size = u64(h, 8);
    if (size === Number.MAX_SAFE_INTEGER) return null;
    headerLen = 16;
  } else if (size === 0) size = end - pos;
  if (size < headerLen || pos + size > end) return null;
  return { type: h.toString('latin1', 4, 8), body: pos + headerLen, bodyLen: size - headerLen, end: pos + size };
}
// A 64-bit field as a Number, clamped: nothing in a real file comes near 2^53, and all ones (the
// "unknown" marker) has to stay recognisable after the conversion.
const u64 = (buf, off) => { const v = buf.readBigUInt64BE(off); return v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v); };
// A duration field that says "unknown": zero (fragmented files) or all ones.
const unknownDur = (d, version) => d === 0 || d === (version === 1 ? Number.MAX_SAFE_INTEGER : 0xffffffff);

/**
 * The brand and length of an MP4/MOV, read from box headers with positioned reads — the moov
 * may sit at the very end (a file written without "fast start"), and the file is never loaded.
 * Returns { brand, durationSec } — durationSec null when the file does not say — or null for
 * anything that is not a well-formed file: no ftyp first, no moov, no mvhd, a zero timescale, a
 * box that overruns its parent, more than 10k boxes, or a moov over 8 MB.
 */
export function mp4Info(fd, size) {
  try {
    let pos = 0, count = 0, brand = null, moov = null;
    while (pos < size) {
      if (++count > MAX_BOXES) return null;
      const b = boxAt(fd, pos, size);
      if (!b) return null;
      if (count === 1) {
        if (b.type !== 'ftyp' || b.bodyLen < 4) return null;
        brand = readAt(fd, b.body, 4).toString('latin1');
      }
      if (b.type === 'moov') { moov = b; break; }
      pos = b.end;
    }
    if (!moov || moov.bodyLen + 8 > MOOV_MAX) return null;
    let timescale = 0, dur = null, fragDur = null, sawMvhd = false;
    pos = moov.body;
    while (pos < moov.end) {
      if (++count > MAX_BOXES) return null;
      const b = boxAt(fd, pos, moov.end);
      if (!b) return null;
      if (b.type === 'mvhd' && !sawMvhd) {
        sawMvhd = true;
        const v = readAt(fd, b.body, Math.min(b.bodyLen, 32));
        if (!v || v.length < 20) return null;
        if (v[0] === 1) {
          if (v.length < 32) return null;
          timescale = v.readUInt32BE(20);
          dur = u64(v, 24);
          if (unknownDur(dur, 1)) dur = null;
        } else {
          timescale = v.readUInt32BE(12);
          dur = v.readUInt32BE(16);
          if (unknownDur(dur, 0)) dur = null;
        }
      } else if (b.type === 'mvex') {
        // A fragmented file (Safari's MediaRecorder, some editors) leaves mvhd at 0 and states
        // the whole length here, in mehd, in the same timescale.
        let p = b.body;
        while (p < b.end) {
          if (++count > MAX_BOXES) return null;
          const c = boxAt(fd, p, b.end);
          if (!c) return null;
          if (c.type === 'mehd') {
            const v = readAt(fd, c.body, Math.min(c.bodyLen, 12));
            if (v && v.length >= 8) {
              const wide = v[0] === 1 && v.length >= 12;
              const d = wide ? u64(v, 4) : v.readUInt32BE(4);
              if (!unknownDur(d, wide ? 1 : 0)) fragDur = d;
            }
          }
          p = c.end;
        }
      }
      pos = b.end;
    }
    if (!sawMvhd || !timescale) return null;
    const ticks = dur ?? fragDur;
    return { brand, durationSec: ticks == null ? null : Math.round((ticks / timescale) * 1000) / 1000 };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- references */

/**
 * Every blob a state refers to: customEx[].media.hash and .poster.hash, and the same two of every
 * entry of workouts[].media (the photos and videos of a logged workout) and of every set's own
 * media list, workouts[].entries[].sets[].media (a form video filmed for that set). Deliberately loose —
 * each field counts on its own as long as it is a well-formed hash, even when the rest of the ref
 * would not pass the client's normalizeMediaRef, and a workout's list counts past the client's
 * cap of six. This set decides what is KEPT, so erring towards more is the safe direction.
 * `active` is not walked: PUT /api/data drops it before the state is stored.
 * frontend/src/lib/media-refs.js has to agree with it; api/test/fixtures/media-refs.json pins
 * both to the same answers.
 */
export function referencedHashes(state) {
  const out = new Set();
  if (!state || typeof state !== 'object') return out;
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const add = r => { if (r && typeof r === 'object' && typeof r.hash === 'string' && HASH_RE.test(r.hash)) out.add(r.hash); };
  const ref = m => { add(m); add(m.poster); };
  for (const c of Array.isArray(state.customEx) ? state.customEx : []) {
    if (isObj(c) && isObj(c.media)) ref(c.media);
  }
  for (const w of Array.isArray(state.workouts) ? state.workouts : []) {
    if (!isObj(w) || !Array.isArray(w.media)) continue;
    for (const m of w.media) if (isObj(m)) ref(m);
  }
  // A set's own form video (v1.4.4): every entry of every set's `media` list, by the same rule.
  for (const w of Array.isArray(state.workouts) ? state.workouts : []) {
    if (!isObj(w) || !Array.isArray(w.entries)) continue;
    for (const e of w.entries) {
      if (!isObj(e) || !Array.isArray(e.sets)) continue;
      for (const st of e.sets) if (isObj(st) && Array.isArray(st.media)) for (const m of st.media) if (isObj(m)) ref(m);
    }
  }
  // Progress photos filed under a day rather than a workout (frontend lib/day-photos.js):
  // dayPhotos[<hash>] = { d, m, _ts }, a cleared one only { _ts }.
  if (isObj(state.dayPhotos)) for (const e of Object.values(state.dayPhotos)) if (isObj(e) && isObj(e.m)) ref(e.m);
  // Sounds of one's own (frontend lib/user-sounds.js): sounds[] = { id, name, m, _ts }.
  for (const e of Array.isArray(state.sounds) ? state.sounds : []) if (isObj(e) && isObj(e.m)) ref(e.m);
  // Your own photo or video on a built-in exercise (frontend lib/ex-media.js, v1.4.5):
  // exMedia[<exercise id>] = { m, show, _ts }, a removed one only { _ts }.
  if (isObj(state.exMedia)) for (const e of Object.values(state.exMedia)) if (isObj(e) && isObj(e.m)) ref(e.m);
  // The profile picture (frontend lib/avatar.js): avatar = { m }, a 256 px square.
  if (isObj(state.avatar) && isObj(state.avatar.m)) ref(state.avatar.m);
  return out;
}

/* ---------------------------------------------------------------- the store */

const round1 = n => Math.round(n * 10) / 10;
const contentType = req => String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
function contentLength(req) {
  const raw = req.headers?.['content-length'];
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
// Reads and discards what is left of a refused upload, so the answer reaches the client instead
// of a connection reset (closing a socket with unread bytes makes the kernel send RST, and a
// client that sees it before parsing the answer reports a dropped connection — see readBody in
// server.js). A client that keeps sending past `limit` is not a mistaken one and is cut off.
function drain(req, limit) {
  if (req.readableEnded || req.destroyed) return;
  let seen = 0;
  req.on('data', d => { seen += d.length; if (seen > limit) req.destroy(); });
  req.on('error', () => {});
  req.resume();
}

/**
 * Streams `req` into a new file at `file`, hashing and counting on the way. Resolves with
 * { size, sha, head } once every byte is on disk and the file is closed. Rejects with a
 * MediaError past `max` bytes (413) or after `idleMs` without a byte (408), with the socket's
 * own error (marked clientGone) when the client hangs up, and with the disk's error otherwise.
 * On every rejection the write stream has closed before the promise settles, so the caller can
 * unlink the file without racing a late open().
 */
function streamToFile(req, file, { max, maxMB, idleMs }) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const head = [];
    let headLen = 0, size = 0, ended = false, settled = false, timer = null;
    const out = fs.createWriteStream(file, { flags: 'wx', mode: 0o600, highWaterMark: 256 * 1024 });
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => settle(new MediaError(408, 'timeout', {}, { Connection: 'close' })), idleMs);
    };
    const detach = () => {
      clearTimeout(timer);
      req.off('data', onData); req.off('end', onEnd); req.off('error', onReqError); req.off('close', onClose);
      out.off('drain', onDrain);
      // A socket that errors again after this must not become an unhandled 'error' event.
      req.on('error', () => {});
    };
    function settle(err, val) {
      if (settled) return;
      settled = true;
      detach();
      if (!err) return resolve(val);
      if (err.code === 'ENOSPC') err = new MediaError(507, 'storage-full');
      if (out.closed) return reject(err);
      out.once('close', () => reject(err));
      out.destroy();
    }
    function onData(chunk) {
      arm();
      size += chunk.length;
      if (size > max) return settle(new MediaError(413, 'media-too-large', { maxMB }));
      hash.update(chunk);
      if (headLen < HEAD_BYTES) {
        // Copied, so the head does not keep a whole 64 KB socket chunk alive.
        const part = Buffer.from(chunk.subarray(0, HEAD_BYTES - headLen));
        head.push(part);
        headLen += part.length;
      }
      if (!out.write(chunk)) req.pause();
    }
    function onDrain() { if (!settled && !ended) { arm(); req.resume(); } }
    function onEnd() {
      ended = true;
      clearTimeout(timer);
      out.end();
      out.once('close', () => {
        if (settled) return;
        settled = true;
        detach();
        resolve({ size, sha: hash.digest('hex'), head: Buffer.concat(head) });
      });
    }
    function onReqError(e) { settle(Object.assign(e || new Error('aborted'), { clientGone: true })); }
    // 'close' before 'end' is a client that went away without an error event (an aborted
    // request on some Node versions); after 'end' it is the ordinary end of the request.
    function onClose() { if (!ended) settle(Object.assign(new Error('client went away mid-upload'), { clientGone: true })); }
    out.on('error', e => settle(e));
    out.on('drain', onDrain);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onReqError);
    req.on('close', onClose);
    arm();
    req.resume();
  });
}

/**
 * The per-instance media store. `dir` is DATA_DIR/uploads. `readState(uid)` returns the
 * profile's stored state, or null when there is none or it does not parse — the store sweeps
 * nobody it gets null for. `now` is injectable so the tests can walk the clock.
 */
export function createMediaStore({ dir, limits, now = Date.now, readState = () => null, idleMs = 60000, log = console, backend = MEDIA_BACKEND, bytes = null } = {}) {
  const L = { ...mediaLimits({}), ...(limits || {}) };
  const quotaBytes = L.quotaMB > 0 ? Math.round(L.quotaMB * MB) : 0;
  const capMB = kind => (kind === 'video' ? L.videoMB : kind === 'gif' ? L.gifMB : kind === 'audio' ? L.audioMB : L.imageMB);
  const capOf = kind => Math.round(capMB(kind) * MB);
  const maxCap = Math.max(capOf('image'), capOf('gif'), capOf('video'), capOf('audio'));
  const users = new Map();          // safe uid -> { dir, bytes, count, reserved, inflight, hashes }
  const orphansLogged = new Set();
  // Blob mode: the byte store (injected by the tests, the real one otherwise) and the deletes this
  // process has already set in motion — keyed by file, so a sweep and a delete of the same file
  // cannot race, and so an upload of a hash whose delete is still running can wait for it instead
  // of racing it and leaving a row whose blob was just taken away.
  const BLOB = backend === 'blob';
  const B = BLOB ? (bytes || createBlobBytes()) : null;
  const inflightDelete = new Map();

  // The same sanitising as server.js stateFile(). An id that sanitises to nothing would name
  // uploads/ itself, and removeUser() would then delete everybody's files.
  function safe(uid) {
    const s = String(uid ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!s) throw new Error('media: a profile id is required');
    return s;
  }
  function ensureDir(p) {
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
    // mkdir's mode is filtered by the umask and does nothing for a directory that already
    // existed; the Coach runtime's uid must not be able to list anyone's files.
    try { fs.chmodSync(p, 0o700); } catch { /* a host filesystem that refuses chmod */ }
  }

  // Built once per profile from one readdir, then kept current by every write and delete, so
  // a state push never lists a directory. Blob mode cannot cache: a file another instance
  // uploaded a second ago has to be visible here too, and this in-memory list is exactly what
  // does not survive two instances sharing one Blob — so it is re-read from the rows every time.
  function entry(uid) {
    const id = safe(uid);
    let e = users.get(id);
    if (e && !BLOB) return e;
    if (!e) e = { id, dir: path.join(dir, id), bytes: 0, count: 0, reserved: 0, inflight: 0, hashes: new Map() };
    if (BLOB) return loadRows(e);
    let names = [];
    try { names = fs.readdirSync(e.dir, { withFileTypes: true }); } catch { /* nothing uploaded yet */ }
    for (const d of names) {
      const m = FILE_RE.exec(d.name);
      if (!m || !d.isFile() || e.hashes.has(m[1])) continue;
      try {
        const size = fs.statSync(path.join(e.dir, d.name)).size;
        // An empty file is what a reset right after an upload can leave behind: not a file this
        // profile has. Left out, it is reported missing and the next upload replaces it.
        if (!size) continue;
        e.hashes.set(m[1], { ext: m[2], size });
        e.bytes += size;
        e.count++;
      } catch { /* went away between readdir and stat */ }
    }
    users.set(id, e);
    return e;
  }
  // Blob: the rows ARE the folder. `deleting` is filtered out because a file marked for deletion
  // is already gone from the app's point of view, and the total comes from `sum(size)` — which
  // Postgres returns as `numeric`, i.e. a STRING through the sync bridge (only `bigint` is parsed
  // to a Number), so it is coerced here. Miss that and `e.bytes + need > quotaBytes` compares a
  // concatenated string against a number and refuses or admits the wrong upload.
  function loadRows(e) {
    e.hashes = new Map();
    for (const r of query('SELECT hash, ext, size FROM media WHERE uid=$1 AND NOT deleting', [e.id])) {
      const size = Number(r.size);
      if (!size) continue;                 // an empty file is not a file this profile has
      e.hashes.set(r.hash, { ext: r.ext, size });
    }
    const total = query('SELECT coalesce(sum(size),0) AS bytes FROM media WHERE uid=$1 AND NOT deleting', [e.id]);
    e.bytes = Number(total[0]?.bytes) || 0;
    e.count = e.hashes.size;
    users.set(e.id, e);
    return e;
  }
  // The cache entry of `hash` when its file is whole: on disk, not empty, the size the cache
  // knows and, given one, the size an upload of the same bytes has. null otherwise.
  function intact(e, hash, size) {
    if (BLOB) {
      const f = e.hashes.get(hash);
      if (!f) return null;
      return size != null && size !== f.size ? null : f;
    }
    const f = e.hashes.get(hash);
    if (!f) return null;
    let st;
    try { st = fs.statSync(path.join(e.dir, `${hash}.${f.ext}`)); } catch { return null; }
    if (!st.size || st.size !== f.size || (size != null && size !== f.size)) return null;
    return f;
  }
  function forget(e, hash) {
    const f = e.hashes.get(hash);
    if (!f) return;
    e.hashes.delete(hash);
    e.bytes -= f.size;
    e.count--;
  }
  const usageOf = e => ({ bytes: e.bytes, count: e.count, quotaBytes });

  /* .gc.json: when each stored hash was last seen leaving the state. Read fresh every time (it
     is a few hundred bytes), so what is on disk is the only truth. Unreadable = no marks: the
     grace starts over, which can only ever keep a file longer. */
  const gcFile = e => path.join(e.dir, '.gc.json');
  function readMarks(e) {
    if (BLOB) {
      // `unreferenced_since` crosses the sync bridge as JSON, so a timestamptz arrives as an ISO
      // string, not a Date: parse it back to the milliseconds the rest of this file works in.
      const out = {};
      for (const r of query('SELECT hash, unreferenced_since FROM media WHERE uid=$1 AND NOT deleting AND unreferenced_since IS NOT NULL', [e.id])) {
        const t = Date.parse(r.unreferenced_since);
        if (Number.isFinite(t)) out[r.hash] = t;
      }
      return out;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(gcFile(e), 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      const out = {};
      for (const [h, t] of Object.entries(raw)) if (HASH_RE.test(h) && Number.isFinite(t)) out[h] = t;
      return out;
    } catch { return {}; }
  }
  function writeMarks(e, marks) {
    if (BLOB) {
      // Two statements, no file: clear the mark on every file this profile holds that is no
      // longer marked, then write each mark that is. `AND NOT deleting` means a file already on
      // its way out is never resurrected by a stale mark.
      const clear = [...e.hashes.keys()].filter(h => !(h in marks));
      if (clear.length) query('UPDATE media SET unreferenced_since = NULL WHERE uid=$1 AND hash = ANY($2) AND NOT deleting', [e.id, clear]);
      for (const [h, t] of Object.entries(marks)) {
        query('UPDATE media SET unreferenced_since = to_timestamp($3::double precision / 1000) WHERE uid=$1 AND hash=$2 AND NOT deleting', [e.id, h, Number(t)]);
      }
      return;
    }
    const f = gcFile(e), tmp = f + '.tmp';
    try {
      const fd = fs.openSync(tmp, 'w', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(marks)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, f);
      syncDir(path.dirname(f));
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* never written */ }
      throw err;
    }
  }
  // Brings the marks in line with `refs`: a referenced hash loses its mark, an unreferenced one
  // without a mark gets `t`, marks for files that are gone are dropped. Returns whether anything
  // changed.
  function reconcile(e, refs, marks, t) {
    let changed = false;
    for (const h of e.hashes.keys()) {
      if (refs.has(h)) { if (h in marks) { delete marks[h]; changed = true; } }
      else if (!(h in marks)) { marks[h] = t; changed = true; }
    }
    for (const h of Object.keys(marks)) if (!e.hashes.has(h)) { delete marks[h]; changed = true; }
    return changed;
  }
  function stateOf(uid) {
    let S = null;
    try { S = readState(uid); } catch { S = null; }
    return S && typeof S === 'object' && !Array.isArray(S) ? S : null;
  }

  function noteState(uid, state) {
    const id = safe(uid);
    // Nothing to do for a profile that never uploaded — and that is the common case, so it
    // costs one stat per profile per process, not a readdir per push. On Blob the same early
    // exit costs one indexed SELECT instead: there is no directory to stat, and skipping it
    // would leave a file another instance uploaded marked forever (it would never be swept).
    if (BLOB) {
      const e = entry(uid);
      if (!e.hashes.size) return false;
      return reconcileMarks(e, state);
    }
    if (!users.has(id) && !fs.existsSync(path.join(dir, id))) return false;
    const e = entry(uid);
    if (!e.hashes.size) return false;
    return reconcileMarks(e, state);
  }
  /** Bring the grace marks in line with what the state now references (both backends). */
  function reconcileMarks(e, state) {
    const marks = readMarks(e);
    const changed = reconcile(e, referencedHashes(state), marks, now());
    if (changed) writeMarks(e, marks);
    return changed;
  }

  function sweep(uid, { graceMs = L.gcGraceDays * DAY } = {}) {
    if (BLOB) return blobSweep(uid, graceMs);
    const e = entry(uid);
    const res = { removed: 0, freedBytes: 0, skipped: false };
    if (!e.hashes.size) return res;
    const S = stateOf(uid);
    if (!S) { res.skipped = true; return res; }   // never infer anything from a missing state
    const refs = referencedHashes(S);
    const marks = readMarks(e);
    const t = now();
    let changed = reconcile(e, refs, marks, t);
    for (const [h, f] of [...e.hashes]) {
      if (refs.has(h)) continue;
      if (graceMs > 0 && !(t - marks[h] >= graceMs)) continue;
      try { fs.unlinkSync(path.join(e.dir, `${h}.${f.ext}`)); }
      catch (err) { if (err.code !== 'ENOENT') { log.error('media: could not delete', e.id, h, err.message); continue; } }
      forget(e, h);
      delete marks[h];
      changed = true;
      res.removed++;
      res.freedBytes += f.size;
    }
    if (changed) {
      try { writeMarks(e, marks); } catch (err) { log.error('media: could not write .gc.json for', e.id, err.message); }
    }
    return res;
  }

  /* ---------- the Blob delete protocol ---------- */

  // Blob is HTTP and every caller of delete/removeUser/sweep is synchronous (server.js, and
  // library/moderation.js — neither is ours to make async), so a delete can never be awaited
  // here. The row carries the truth instead, in two steps:
  //
  //   1. `deleting` flips (one synchronous UPDATE). Every read filters it out, so the file is
  //      gone from the app at once — the same user-visible behaviour as the unlink on fs.
  //   2. The blob goes, then the row goes.
  //
  // A failure at either step, or a process that dies in the middle, leaves the row `deleting`:
  // invisible, uncounted, never served, and retried by the next sweep. The one thing that must
  // never happen is bytes that stay in Blob billed forever with no row saying they must go.
  function finishDelete(rows) {
    const fresh = rows.filter(r => !inflightDelete.has(`${r.uid}/${r.hash}`));
    if (!fresh.length) return;
    const release = () => { for (const r of fresh) inflightDelete.delete(`${r.uid}/${r.hash}`); };
    const work = B.del(fresh.map(r => blobPathname(r.uid, r.hash, r.ext))).then(() => {
      try {
        const byUid = new Map();
        for (const r of fresh) {
          if (!byUid.has(r.uid)) byUid.set(r.uid, []);
          byUid.get(r.uid).push(r.hash);
        }
        for (const [uid, hashes] of byUid) query('DELETE FROM media WHERE uid=$1 AND hash = ANY($2)', [uid, hashes]);
      } catch (err) {
        // The blobs are gone; the rows are not. The next retry finds no blob (which counts as
        // deleted) and removes them then, so this can never become a permanent state.
        log.error('media: blob(s) deleted, rows left for the next sweep:', err.message);
      } finally { release(); }
    }, err => {
      release();
      log.error('media: could not delete blob(s); left marked deleting for the next sweep:', err.message);
    });
    // Registered AFTER the promise exists so an upload of these very bytes can await it: writing
    // the blob while its delete is in flight would leave a live row over bytes that just went.
    for (const r of fresh) inflightDelete.set(`${r.uid}/${r.hash}`, work);
  }
  /** Every delete this process left half-done — for one profile, or for all of them. */
  function retryStranded(uid = null) {
    const rows = uid == null
      ? query('SELECT uid, hash, ext FROM media WHERE deleting')
      : query('SELECT uid, hash, ext FROM media WHERE uid=$1 AND deleting', [uid]);
    if (rows.length) finishDelete(rows);
  }

  /** The sweep on Blob: same grace, same "a state that cannot be read removes nothing", same
   *  counters — only the removal is the two-step delete above. A stranded delete is retried first,
   *  so one hourly pass is enough to heal whatever the previous one could not finish. */
  function blobSweep(uid, graceMs) {
    retryStranded(uid);
    const e = entry(uid);
    const res = { removed: 0, freedBytes: 0, skipped: false };
    if (!e.hashes.size) return res;
    const S = stateOf(uid);
    if (!S) { res.skipped = true; return res; }   // never infer anything from a missing state
    const refs = referencedHashes(S);
    const marks = readMarks(e);
    const t = now();
    const changed = reconcile(e, refs, marks, t);
    const doomed = [];
    for (const [h, f] of [...e.hashes]) {
      if (refs.has(h)) continue;
      if (graceMs > 0 && !(t - marks[h] >= graceMs)) continue;
      doomed.push([h, f]);
    }
    if (doomed.length) {
      const rows = query('UPDATE media SET deleting = true WHERE uid=$1 AND hash = ANY($2) AND NOT deleting RETURNING hash, ext, size',
        [e.id, doomed.map(([h]) => h)]);
      for (const r of rows) { forget(e, r.hash); delete marks[r.hash]; }
      res.removed = rows.length;
      res.freedBytes = rows.reduce((n, r) => n + Number(r.size), 0);
      if (rows.length) finishDelete(rows.map(r => ({ uid: e.id, hash: r.hash, ext: r.ext })));
    }
    if (changed) {
      try { writeMarks(e, marks); } catch (err) { log.error('media: could not update unreferenced_since for', e.id, err.message); }
    }
    return res;
  }

  // Temp files of uploads that died with the process, or that a crash between write and rename
  // left behind. `olderThan` 0 = all of them (boot, when nothing can be in flight).
  function cleanTmpOf(userDir, olderThan) {
    const t = now();
    const tmpDir = path.join(userDir, '.tmp');
    let names = [];
    try { names = fs.readdirSync(tmpDir); } catch { /* none */ }
    let n = 0;
    for (const name of names) {
      const p = path.join(tmpDir, name);
      try {
        if (olderThan > 0 && t - fs.statSync(p).mtimeMs < olderThan) continue;
        fs.rmSync(p, { recursive: true, force: true });
        n++;
      } catch { /* gone already */ }
    }
    try {
      const g = path.join(userDir, '.gc.json.tmp');
      if (olderThan === 0 || t - fs.statSync(g).mtimeMs >= olderThan) fs.unlinkSync(g);
    } catch { /* none */ }
    return n;
  }
  const userDirs = () => {
    try { return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name); }
    catch { return []; }
  };

  function markIfUnreferenced(uid, e, hash) {
    const S = stateOf(uid);
    if (S && referencedHashes(S).has(hash)) return;
    const marks = readMarks(e);
    marks[hash] = now();
    writeMarks(e, marks);
  }
  // A device just vouched for a file the server already has. If it was on its way out, the
  // grace starts over: the state push that references it is usually a second behind.
  function touch(e, hash) {
    try {
      const marks = readMarks(e);
      if (!(hash in marks)) return;
      marks[hash] = now();
      writeMarks(e, marks);
    } catch (err) { log.error('media: could not write .gc.json for', e.id, err.message); }
  }
  function freeBytes(p) {
    try { const s = fs.statfsSync(p); return Number(s.bavail) * Number(s.bsize); }
    catch { return null; }    // a filesystem that cannot say: no floor rather than no uploads
  }
  const existed = (hash, f) => ({ status: 200, body: { ok: true, hash, mime: EXT_MIME[f.ext], size: f.size, existed: true } });

  async function receive(uid, hash, req) {
    if (!HASH_RE.test(String(hash))) { drain(req, maxCap); throw new MediaError(400, 'bad-request'); }
    const e = entry(uid);
    if (e.inflight >= MAX_INFLIGHT) {
      drain(req, 2 * maxCap);
      throw new MediaError(429, 'busy', { retryAfter: 5 }, { 'Retry-After': '5' });
    }
    e.inflight++;
    let reserved = 0, tmp = null, cap = maxCap;
    try {
      const declared = MEDIA_TYPES[contentType(req)];
      if (!declared) throw new MediaError(415, 'media-type');
      cap = capOf(declared.kind);
      const len = contentLength(req);
      if (len != null && len > cap) {
        // Drained like a refusal before receive() (discard): up to twice the LARGEST cap. Twice
        // this kind's cap would cut a photo of 5 MB off at 4 MB with a reset, and a client that
        // hits the reset before the answer reads a network error and tries again forever.
        cap = maxCap;
        throw new MediaError(413, 'media-too-large', { maxMB: capMB(declared.kind) });
      }
      // A file this profile already has is taken as it is, unless it is not whole: its size on
      // disk differs from what the cache knows or from what this upload declares (a reset right
      // after an upload, a damaged restore). Then these bytes, checked against the hash below,
      // replace it, instead of the damaged file being vouched for forever.
      const have = intact(e, hash, len);
      if (have) { drain(req, 2 * cap); touch(e, hash); return existed(hash, have); }

      // Reserved before a byte is read, so two uploads at once cannot both fit into the space
      // that is only left for one.
      const need = len ?? cap;
      if (quotaBytes && e.bytes + e.reserved + need > quotaBytes) {
        // Space the person already let go of may still be sitting out its grace period; under
        // pressure it gets an hour instead of two weeks.
        try { sweep(uid, { graceMs: HOUR }); } catch (err) { log.error('media: quota sweep failed for', e.id, err.message); }
        if (e.bytes + e.reserved + need > quotaBytes) {
          throw new MediaError(413, 'media-quota', { usedMB: round1(e.bytes / MB), quotaMB: L.quotaMB });
        }
      }
      e.reserved += need;
      reserved = need;

      ensureDir(dir);
      ensureDir(e.dir);
      ensureDir(path.join(e.dir, '.tmp'));
      if (L.minFreeMB > 0) {
        const free = freeBytes(e.dir);
        if (free != null && free - need < L.minFreeMB * MB) throw new MediaError(507, 'storage-full');
      }

      tmp = path.join(e.dir, '.tmp', crypto.randomBytes(12).toString('hex'));
      const got = await streamToFile(req, tmp, { max: cap, maxMB: capMB(declared.kind), idleMs });

      if (got.sha !== hash) throw new MediaError(400, 'hash-mismatch');
      const sn = sniffMedia(got.head);
      if (!sn || sn.category !== declared.category) throw new MediaError(415, 'media-type');
      if (got.size > capOf(sn.kind)) throw new MediaError(413, 'media-too-large', { maxMB: capMB(sn.kind) });
      if (sn.ext === 'mp4' || sn.ext === 'mov') {
        const fd = fs.openSync(tmp, 'r');
        let info;
        try { info = mp4Info(fd, got.size); } finally { fs.closeSync(fd); }
        if (!info) throw new MediaError(415, 'media-invalid');
        // One second of slack: the client measures with the platform's player, which rounds.
        if (info.durationSec != null && info.durationSec > L.videoSec + 1) throw new MediaError(413, 'media-too-long', { maxSec: L.videoSec });
      }

      // The same bytes from another device may have landed while these were streaming. The
      // rename and the cache update below are synchronous, so this check cannot be overtaken.
      const now2 = intact(e, hash, got.size);
      if (now2) { touch(e, hash); return existed(hash, now2); }
      if (BLOB) {
        // A delete of these very bytes may still be running (the file aged out while this upload
        // was on its way): let it finish first, or its row DELETE lands after our INSERT and takes
        // the fresh row with it.
        const pending = inflightDelete.get(`${e.id}/${hash}`);
        if (pending) await pending;
        // Bytes first, row second: a row promising a blob nobody wrote would be a 404 no sweep
        // could ever heal. The staging file stays set, so the finally below removes it.
        const damaged = e.hashes.get(hash);
        if (damaged && damaged.ext !== sn.ext) {
          B.del([blobPathname(e.id, hash, damaged.ext)])
            .catch(err => log.error('media: could not delete the old blob of', e.id, hash, err.message));
        }
        await B.put(blobPathname(e.id, hash, sn.ext), tmp);
        query(
          'INSERT INTO media (uid, hash, ext, size, unreferenced_since) VALUES ($1, $2, $3, $4, NULL) ' +
          'ON CONFLICT (uid, hash) DO UPDATE SET ext = EXCLUDED.ext, size = EXCLUDED.size, deleting = false, unreferenced_since = NULL',
          [e.id, hash, sn.ext, got.size]);
        // Re-read: another instance may have written this row while the bytes were in flight, and
        // the in-memory counters must never count one row twice.
        loadRows(e);
        // Unreferenced until the state push that names it arrives; the mark is what lets the
        // grace protect it until then, and what lets it go if that push never comes.
        try { markIfUnreferenced(uid, e, hash); } catch (err) { log.error('media: could not mark', e.id, hash, err.message); }
        return { status: 201, body: { ok: true, hash, mime: sn.mime, size: got.size, existed: false } };
      }
      // The bytes are on disk before the name is, and the name before the answer (durable.js).
      syncFile(tmp);
      const damaged = e.hashes.get(hash);
      if (damaged) {
        if (damaged.ext !== sn.ext) { try { fs.unlinkSync(path.join(e.dir, `${hash}.${damaged.ext}`)); } catch { /* gone */ } }
        forget(e, hash);
      }
      fs.renameSync(tmp, path.join(e.dir, `${hash}.${sn.ext}`));
      tmp = null;
      syncDir(e.dir);
      e.hashes.set(hash, { ext: sn.ext, size: got.size });
      e.bytes += got.size;
      e.count++;
      // Unreferenced until the state push that names it arrives; the mark is what lets the
      // grace protect it until then, and what lets it go if that push never comes.
      try { markIfUnreferenced(uid, e, hash); } catch (err) { log.error('media: could not mark', e.id, hash, err.message); }
      return { status: 201, body: { ok: true, hash, mime: sn.mime, size: got.size, existed: false } };
    } catch (err) {
      // Whatever went wrong on this side — a refusal, or the disk — the rest of the body is
      // still on its way, and a request left paused would hold the connection until the
      // request timeout. A client that hung up has nothing left to drain.
      if (!err?.clientGone) drain(req, 2 * cap);
      throw err;
    } finally {
      if (tmp) { try { fs.unlinkSync(tmp); } catch { /* never created, or already gone */ } }
      e.reserved -= reserved;
      e.inflight--;
    }
  }

  return {
    limits: L,
    /** For a refusal decided before receive() (no session, the hourly budget): takes at most
     *  twice the largest cap off the wire so the answer arrives, then closes the socket, instead
     *  of leaving node to read an unbounded body to its end. */
    discard: req => drain(req, 2 * maxCap),
    usage: uid => usageOf(entry(uid)),
    has: (uid, hash) => entry(uid).hashes.has(hash),
    /** { path, ext, mime, size } of a stored file, or null. Checks the disk, so a file that
     *  vanished from under the cache is forgotten rather than answered with a 500. On Blob there
     *  is no path and no stat: the row is the answer, and `stream` is how the bytes are reached —
     *  still synchronous in shape, because server.js calls this without `await`. */
    file(uid, hash) {
      if (BLOB) {
        const id = safe(uid);
        const rows = query('SELECT ext, size FROM media WHERE uid=$1 AND hash=$2 AND NOT deleting AND size > 0', [id, hash]);
        if (!rows.length) return null;
        const ext = rows[0].ext;
        const size = Number(rows[0].size);
        return { ext, mime: EXT_MIME[ext], size, stream: () => B.stream(blobPathname(id, hash, ext)) };
      }
      const e = entry(uid);
      const f = e.hashes.get(hash);
      if (!f) return null;
      const p = path.join(e.dir, `${hash}.${f.ext}`);
      let st;
      try { st = fs.statSync(p); } catch { forget(e, hash); return null; }
      if (!st.isFile()) return null;
      if (!st.size) { forget(e, hash); return null; }   // not whole: missing, for a device to send again
      if (st.size !== f.size) { e.bytes += st.size - f.size; f.size = st.size; }
      return { path: p, ext: f.ext, mime: EXT_MIME[f.ext], size: st.size };
    },
    /** The bytes of an upload as a LOCAL file, for the one caller that has to read them: the
     *  community library's metadata scrub (library/metadata.js) and its hard-link into shared/.
     *  fs already holds the file — hand over its path, no copy, and a release() that does nothing.
     *  Blob downloads into the profile's staging folder; release() takes that copy away again and
     *  the caller runs it in a `finally`, so a refusal halfway through leaks no temp file. */
    async materialize(uid, hash) {
      const e = entry(uid);
      const f = e.hashes.get(hash);
      if (!f) throw new MediaError(404, 'media-missing');
      if (!BLOB) {
        // Checked like file() checks it: a path to nothing must come back as the same 404 the
        // lookup would give, not as an ENOENT from the metadata scrub further down.
        const p = path.join(e.dir, `${hash}.${f.ext}`);
        let st;
        try { st = fs.statSync(p); } catch { forget(e, hash); throw new MediaError(404, 'media-missing'); }
        if (!st.isFile() || !st.size) throw new MediaError(404, 'media-missing');
        return { path: p, release: () => {} };
      }
      ensureDir(dir);
      ensureDir(e.dir);
      ensureDir(path.join(e.dir, '.tmp'));
      const tmp = path.join(e.dir, '.tmp', crypto.randomBytes(12).toString('hex'));
      try { await B.download(blobPathname(e.id, hash, f.ext), tmp); }
      catch (err) { try { fs.unlinkSync(tmp); } catch { /* never landed */ } throw err; }
      return { path: tmp, release: () => { try { fs.unlinkSync(tmp); } catch { /* already gone */ } } };
    },
    receive,
    missing(uid, hashes) {
      const e = entry(uid);
      // A file that is not whole (intact) counts as missing: the device that has it sends it again.
      return { missing: [...new Set(hashes)].filter(h => !intact(e, h)), usage: usageOf(e) };
    },
    noteState,
    sweep,
    /** The hourly pass. Only profiles in `uids` are swept, and only when their state reads;
     *  a folder that belongs to nobody in db.json is left alone and said so, once per process —
     *  only an admin deleting the profile removes a folder. */
    sweepAll({ uids = [], graceMs } = {}) {
      const known = new Map();
      for (const u of uids) { try { known.set(safe(u), u); } catch { /* unusable id */ } }
      const out = { swept: 0, removed: 0, freedBytes: 0, skipped: 0, orphans: 0, tmp: 0 };
      if (BLOB) {
        // The local directories are only staging folders now: clean them, and warn once about one
        // that belongs to nobody, exactly as on fs. The sweep itself walks the PROFILES rather
        // than the directories, because a profile whose bytes all live in Blob may have no
        // directory at all — and the stranded deletes of profiles that no longer exist have to
        // be retried whether or not any profile is left to sweep.
        for (const name of userDirs()) {
          out.tmp += cleanTmpOf(path.join(dir, name), HOUR);
          if (!known.has(name)) {
            out.orphans++;
            if (!orphansLogged.has(name)) {
              orphansLogged.add(name);
              log.warn(`media: uploads/${name} belongs to no profile in db.json — left alone`);
            }
          }
        }
        retryStranded();
        for (const uid of known.values()) {
          try {
            const r = sweep(uid, graceMs === undefined ? {} : { graceMs });
            if (r.skipped) out.skipped++; else out.swept++;
            out.removed += r.removed;
            out.freedBytes += r.freedBytes;
          } catch (err) { log.error('media: sweep failed for', uid, err.message); }
        }
        return out;
      }
      for (const name of userDirs()) {
        out.tmp += cleanTmpOf(path.join(dir, name), HOUR);
        const uid = known.get(name);
        if (uid === undefined) {
          out.orphans++;
          if (!orphansLogged.has(name)) {
            orphansLogged.add(name);
            log.warn(`media: uploads/${name} belongs to no profile in db.json — left alone`);
          }
          continue;
        }
        try {
          const r = sweep(uid, graceMs === undefined ? {} : { graceMs });
          if (r.skipped) out.skipped++; else out.swept++;
          out.removed += r.removed;
          out.freedBytes += r.freedBytes;
        } catch (err) { log.error('media: sweep failed for', name, err.message); }
      }
      return out;
    },
    /** A file copied in from the shared library (an import): into the profile's own folder, against
     *  its quota, marked like a fresh upload until the state that names it arrives. A hash the
     *  profile already has is left as it is. Async on Blob, where "copying it in" is a PUT — the
     *  library's copy is local, the profile's is not — so the one caller awaits it. */
    async adopt(uid, hash, src, ext) {
      if (!HASH_RE.test(hash) || !EXT_MIME[ext]) throw new MediaError(400, 'bad-request');
      const e = entry(uid);
      if (intact(e, hash)) { touch(e, hash); return { existed: true }; }
      const size = fs.statSync(src).size;
      if (quotaBytes && e.bytes + e.reserved + size > quotaBytes) throw new MediaError(413, 'media-quota', { usage: usageOf(e) });
      if (BLOB) {
        const pending = inflightDelete.get(`${e.id}/${hash}`);
        if (pending) await pending;
        await B.put(blobPathname(e.id, hash, ext), src);
        query(
          'INSERT INTO media (uid, hash, ext, size, unreferenced_since) VALUES ($1, $2, $3, $4, NULL) ' +
          'ON CONFLICT (uid, hash) DO UPDATE SET ext = EXCLUDED.ext, size = EXCLUDED.size, deleting = false, unreferenced_since = NULL',
          [e.id, hash, ext, size]);
        loadRows(e);
        try { markIfUnreferenced(uid, e, hash); } catch (err) { log.error('media: could not mark', e.id, hash, err.message); }
        return { existed: false, size };
      }
      ensureDir(e.dir);
      const dst = path.join(e.dir, `${hash}.${ext}`);
      const tmp = dst + '.adopt';
      try { fs.unlinkSync(tmp); } catch { /* none */ }
      try { fs.linkSync(src, tmp); } catch { fs.copyFileSync(src, tmp); }
      fs.renameSync(tmp, dst);
      syncDir(e.dir);
      forget(e, hash);
      e.hashes.set(hash, { ext, size });
      e.bytes += size;
      e.count++;
      try { markIfUnreferenced(uid, e, hash); } catch (err) { log.error('media: could not mark', e.id, hash, err.message); }
      return { existed: false, size };
    },
    /** One file out of a profile's folder: only the library's admin removal asks, and only for a
     *  file its import copied there. Synchronous in both modes — library/moderation.js calls it
     *  inside a loop and is not ours to make async — so on Blob it marks the row and lets the
     *  bytes follow through the delete protocol above. */
    dropFile(uid, hash) {
      const e = entry(uid);
      const f = e.hashes.get(hash);
      if (!f) return false;
      if (BLOB) {
        const rows = query('UPDATE media SET deleting = true WHERE uid=$1 AND hash=$2 AND NOT deleting RETURNING hash, ext', [e.id, hash]);
        forget(e, hash);
        if (rows.length) finishDelete([{ uid: e.id, hash, ext: rows[0].ext }]);
        return true;
      }
      try { fs.unlinkSync(path.join(e.dir, `${hash}.${f.ext}`)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      forget(e, hash);
      return true;
    },
    /** Admin delete: the profile's whole folder. */
    removeUser(uid) {
      const id = safe(uid);
      users.delete(id);
      if (BLOB) {
        const rows = query('UPDATE media SET deleting = true WHERE uid=$1 AND NOT deleting RETURNING hash, ext', [id]);
        if (rows.length) finishDelete(rows.map(r => ({ uid: id, hash: r.hash, ext: r.ext })));
        return;
      }
      fs.rmSync(path.join(dir, id), { recursive: true, force: true });
    },
    /** Boot: nothing is in flight yet, so every temp file is a leftover. */
    cleanTmp() {
      let n = 0;
      for (const name of userDirs()) n += cleanTmpOf(path.join(dir, name), 0);
      return n;
    }
  };
}
