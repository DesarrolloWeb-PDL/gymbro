// The Blob half of the media store (gymbro vercel port, T5): where the BYTES of a profile's
// uploads live once MEDIA_BACKEND=blob, and the name they live under. The METADATA — who has
// which hash, how big it is, when it stopped being referenced — is rows in the `media` table
// (api/migrations/0001_init.sql + 0002_media_deleting.sql) and stays in media.js, through the one
// query handle api/storage.js exports: one pool, never a second one.
//
// Two rules this file exists to keep:
//
// - MEDIA_BACKEND is validated HERE, at load, the way STORAGE_DRIVER is in storage.js: an unknown
//   name throws before the server opens a port instead of quietly falling back to the local
//   filesystem. An instance that believes its uploads are in Blob while they land in files loses
//   them on the first container restart.
// - The SDK is never imported eagerly. `@vercel/blob` is pulled in on the first put/get/del, so
//   every process that runs with MEDIA_BACKEND=fs — the default, every self-hosted install and
//   the whole test suite — never loads it.
//
// Nothing here reads free disk space or asks Blob how much room is left: Blob has no such API, so
// the 507 floor in media.js stays scoped to the local staging directory the upload streams into.
import fs from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** `fs` (default) or `blob`. Anything else is a boot error, never a silent fallback to fs. */
export function selectMediaBackend(name = process.env.MEDIA_BACKEND || 'fs') {
  switch (name) {
    case 'fs': return 'fs';
    case 'blob': return 'blob';
    default: throw new Error(`Unknown MEDIA_BACKEND "${name}": no such media backend (known: fs, blob)`);
  }
}

/** Chosen at load, so a typo is a failed boot rather than a deploy that stores nothing. */
export const MEDIA_BACKEND = selectMediaBackend();

/** Where one upload lives in Blob: private, named by the hash it was verified against. */
export const blobPathname = (uid, hash, ext) => `uploads/${uid}/${hash}.${ext}`;

let sdk = null;
const blob = () => (sdk ??= import('@vercel/blob'));

/**
 * The four byte operations the store needs. All asynchronous — Blob is HTTP — which is why every
 * synchronous caller in server.js and library/moderation.js drives them through the two-step
 * delete in media.js (row first, bytes second, retried by the sweep) instead of awaiting them.
 *
 * `stream` is the exception that answers synchronously: it hands back a PassThrough now and fills
 * it from a GET already in flight, so `file()` keeps its synchronous shape — server.js:2316 calls
 * it without `await`, and a Promise-shaped result there is a 404 for every upload.
 */
export function createBlobBytes() {
  return {
    /** The local file at `localPath` becomes the blob at `pathname`. Overwrite is allowed on
     *  purpose: a re-upload of a hash the server holds as damaged must replace those bytes. */
    async put(pathname, localPath) {
      const { put } = await blob();
      const body = fs.createReadStream(localPath);
      try { await put(pathname, body, { access: 'private', allowOverwrite: true }); }
      finally { body.destroy(); }
    },

    /** The blob's bytes as a local file at `localPath` (created exclusively): the copy the
     *  community library's metadata scrub and its hard-link into shared/ both need. */
    async download(pathname, localPath) {
      const { get } = await blob();
      const r = await get(pathname, { access: 'private' });
      if (!r || !r.stream) throw Object.assign(new Error(`media: no blob at ${pathname}`), { code: 'ENOENT' });
      await pipeline(Readable.fromWeb(r.stream), fs.createWriteStream(localPath, { flags: 'wx', mode: 0o600 }));
    },

    /** Drop these blobs. A blob that is already gone is the delete having landed, not a failure:
     *  the row is removed either way, so a retry after a crash between the two cannot loop. */
    async del(pathnames) {
      if (!pathnames.length) return;
      const { del } = await blob();
      try { await del(pathnames); }
      catch (e) { if (e?.name !== 'BlobNotFoundError') throw e; }
    },

    /** A readable of the blob, without blocking the caller on the GET. A blob that vanished
     *  between the row and here destroys the stream, which ends the response — the row said it
     *  was there, and a row that lies is the one thing this store must not paper over. */
    stream(pathname) {
      const out = new PassThrough();
      (async () => {
        const { get } = await blob();
        const r = await get(pathname, { access: 'private' });
        if (!r || !r.stream) throw Object.assign(new Error(`media: no blob at ${pathname}`), { code: 'ENOENT' });
        await pipeline(Readable.fromWeb(r.stream), out);
      })().catch(err => out.destroy(err));
      return out;
    },
  };
}
