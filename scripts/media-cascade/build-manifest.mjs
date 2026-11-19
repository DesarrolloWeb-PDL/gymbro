#!/usr/bin/env node
/**
 * build-manifest.mjs — task T1 of the gymbro exercise-media cascade (spec S1).
 *
 * Decides, for every exercise in catalogue/exercises, which external source (if any)
 * would provide its media. Exact normalised name equality only — no fuzzy, no substring.
 *
 * Cascade priority: repdb -> workout-guide -> everkinetic -> namnq -> omercotkd.
 *   - sources 1..3 match on the normalised English name.
 *   - omercotkd joins on openGym's own exercise id (its CSV ids ARE openGym ids).
 *   - variantOf pointers inherit their parent's resolution; they never consume a source asset.
 *
 * Invariants enforced (and re-checked after the run):
 *   - one source asset is never assigned to two different normalised names;
 *   - one source record is never assigned to two different normalised names;
 *   - summary.covered + summary.uncovered === summary.named + summary.variants.
 *
 * This script only fetches list files (JSON/CSV) and writes manifest.json.
 * It never downloads an image, GIF, SVG or video.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CATALOGUE_DIR = path.join(REPO, 'catalogue', 'exercises');
const OUT_FILE = path.join(HERE, 'manifest.json');

const NORMALISATION = 'lowercase, strip diacritics/punctuation, degree, collapse space';

const UA = { 'user-agent': 'opencode-gymbro-media-cascade/1.0 (manifest builder)' };

async function fetchText(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`fetch failed ${res.status} ${url}`);
  return res.text();
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

/**
 * Normalisation used for every comparison on both sides of every join:
 * lowercase -> ° becomes the word "degree" -> strip diacritics -> punctuation becomes a
 * space -> collapse whitespace -> trim.
 */
function normalise(value) {
  if (typeof value !== 'string') return '';
  return value
    .toLowerCase()
    .replace(/°/g, ' degree ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Source metadata — licence and obligation strings are the ones T3 will publish.
// ---------------------------------------------------------------------------
const SOURCES = [
  {
    key: 'repdb',
    url: 'https://huggingface.co/datasets/RepDB/exercise-dataset/raw/main/exercises.json',
    licence: 'RepDB Free Tier License v1.0 (proprietary, not CC)',
    licenceUrl: 'https://huggingface.co/datasets/RepDB/exercise-dataset/blob/main/LICENSE.md',
    obligation:
      'Visible credit required: "Exercise data by RepDB (repdb.co)" in the about/credits screen, README or footer. No redistribution as a dataset. No generative-AI derivatives. Resizing, cropping and recolouring in-app are allowed.',
    kind: 'still',
  },
  {
    key: 'workout-guide',
    url: 'https://raw.githubusercontent.com/bryllim/workout-guide/main/packages/workout-guide/manifest.json',
    licence: 'CC BY-SA 4.0',
    licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    obligation:
      'Credit the creator (Bryl Lim), indicate changes, and ShareAlike: adaptations (resizing to 180 px counts as an adaptation) must be released under CC BY-SA 4.0.',
    kind: 'still+clip',
  },
  {
    key: 'everkinetic',
    url: 'https://raw.githubusercontent.com/everkinetic/data/main/exercises.json',
    licence: 'CC BY-SA 4.0',
    licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    obligation:
      'Credit Everkinetic (Greg Priday), indicate changes, and ShareAlike: adaptations (resizing to 180 px counts as an adaptation) must be released under CC BY-SA 4.0.',
    kind: 'still',
  },
  {
    key: 'namnq',
    url: 'https://raw.githubusercontent.com/namnq/workout-free-videos/main/data/exercises.json',
    licence: 'CC0 1.0',
    licenceUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    obligation: 'No conditions (CC0 dedication).',
    kind: 'still+clip',
  },
  {
    key: 'omercotkd',
    url: 'https://raw.githubusercontent.com/omercotkd/exercises-gifs/main/exercises.csv',
    licence: 'MIT (disputed: the README disclaims ownership of the content)',
    licenceUrl: 'https://github.com/omercotkd/exercises-gifs/blob/main/LICENSE',
    obligation:
      'Risk accepted by the user: the repository ships an MIT LICENSE while its README states "I do not own any of the content in this repository. All rights belong to the original creators and dataset owner." The contradiction is unresolved.',
    kind: 'still+clip',
  },
];

const RAW = {
  repdbBase: 'https://huggingface.co/datasets/RepDB/exercise-dataset/resolve/main/',
  workoutGuideBase: 'https://raw.githubusercontent.com/bryllim/workout-guide/main/packages/workout-guide/',
  everkineticBase: 'https://raw.githubusercontent.com/everkinetic/data/main/',
  namnqBase: 'https://raw.githubusercontent.com/namnq/workout-free-videos/main/',
  omercotkdBase: 'https://raw.githubusercontent.com/omercotkd/exercises-gifs/main/',
};

// ---------------------------------------------------------------------------
// CSV parsing (omercotkd) — RFC4180-ish, enough for this file.
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------------------
// Catalogue loading
// ---------------------------------------------------------------------------
function loadCatalogue() {
  const files = fs.readdirSync(CATALOGUE_DIR).filter((f) => f.endsWith('.json')).sort();
  const exercises = files.map((file) => {
    const raw = JSON.parse(fs.readFileSync(path.join(CATALOGUE_DIR, file), 'utf8'));
    if (raw.id !== path.basename(file, '.json')) throw new Error(`id/filename mismatch: ${file}`);
    return { id: raw.id, name: typeof raw.name === 'string' && raw.name ? raw.name : null, variantOf: raw.variantOf ?? null };
  });
  const byId = new Map(exercises.map((e) => [e.id, e]));

  // Resolve a variantOf pointer to the named ancestor (chains are 1 hop in this catalogue,
  // but the walk is general and cycle-guarded).
  function resolve(id) {
    const seen = new Set();
    let current = byId.get(id);
    while (current) {
      if (current.name) return current;
      if (!current.variantOf || seen.has(current.id)) return null;
      seen.add(current.id);
      current = byId.get(current.variantOf);
    }
    return null;
  }
  return { exercises, byId, resolve };
}

// ---------------------------------------------------------------------------
// Source pools: normalised name (or id) -> { ref, asset }. Built with a
// "one asset, one normalised name" guard so a record can never serve two names.
// ---------------------------------------------------------------------------
function makeNamePool(records) {
  const byName = new Map();
  const assetOwner = new Map(); // asset -> normalised name
  let skippedNoAsset = 0, skippedAssetConflict = 0, skippedDuplicate = 0;
  for (const record of records) {
    if (!record.normName) continue;
    if (!record.asset) { skippedNoAsset++; continue; }
    const owner = assetOwner.get(record.asset);
    if (owner !== undefined) {
      if (owner !== record.normName) { skippedAssetConflict++; continue; }
      skippedDuplicate++; // same name, same asset: keep the first record
      continue;
    }
    assetOwner.set(record.asset, record.normName);
    if (!byName.has(record.normName)) byName.set(record.normName, { ref: record.ref, asset: record.asset });
  }
  return { byName, stats: { skippedNoAsset, skippedAssetConflict, skippedDuplicate } };
}

async function buildPools() {
  const pools = {};
  const stats = {};

  // 1. RepDB — WebP stills: images.flat.main, else images.flat.peak for two-phase exercises.
  {
    const data = await fetchJson(SOURCES[0].url);
    const records = data.exercises.map((r) => {
      const flat = r.images?.flat ?? {};
      const rel = flat.main ?? flat.peak ?? flat.start ?? null;
      return { ref: r.id, normName: normalise(r.name_en), asset: rel ? RAW.repdbBase + rel : null };
    });
    pools.repdb = makeNamePool(records);
    stats.repdb = { list: records.length, ...pools.repdb.stats };
    pools.repdb.count = data.count ?? records.length;
  }

  // 2a. workout-guide — 3 SVG frames per exercise; frame 1 is the still, frames build the clip.
  {
    const list = await fetchJson(SOURCES[1].url);
    const records = list.map((r) => {
      const frame = r.frames?.[0]?.path ?? null;
      return { ref: r.id, normName: normalise(r.name), asset: frame ? RAW.workoutGuideBase + frame : null };
    });
    pools['workout-guide'] = makeNamePool(records);
    stats['workout-guide'] = { list: records.length, ...pools['workout-guide'].stats };
    pools['workout-guide'].count = records.length;
  }

  // 2b. everkinetic — the root exercises.json carries the titles (293) but its `img` paths
  // are stale; dist/exercises.json is the source's own asset manifest with live PNG paths.
  // Records are joined to their asset by id_num. The one place the root file is ambiguous is
  // id_num 0020, claimed by two different exercises: there only the record whose title matches
  // the dist title may claim the asset, so a pairing is never a guess.
  {
    const [root, dist] = await Promise.all([
      fetchJson(SOURCES[2].url),
      fetchJson(`${RAW.everkineticBase}dist/exercises.json`),
    ]);
    const distById = new Map();
    for (const d of dist) {
      const png = (d.png ?? []).find((p) => p.includes('-tension')) ?? (d.png ?? [])[0] ?? null;
      distById.set(d.id, { title: d.title, asset: png ? RAW.everkineticBase + 'dist/' + png : null });
    }
    const claims = new Map();
    for (const r of root) claims.set(r.id_num, (claims.get(r.id_num) ?? 0) + 1);
    let ambiguousDropped = 0;
    const records = root.map((r) => {
      const d = distById.get(r.id_num);
      let asset = d?.asset ?? null;
      if (asset && claims.get(r.id_num) > 1 && normalise(d.title) !== normalise(r.title)) {
        asset = null;
        ambiguousDropped++;
      }
      return { ref: r.id_num, normName: normalise(r.title), asset };
    });
    pools.everkinetic = makeNamePool(records);
    stats.everkinetic = { list: records.length, distList: dist.length, ambiguousDropped, ...pools.everkinetic.stats };
    pools.everkinetic.count = records.length;
  }

  // 3. namnq — CC0 MP4 clips.
  {
    const list = await fetchJson(SOURCES[3].url);
    const records = list.map((r) => ({
      ref: r.id,
      normName: normalise(r.name),
      asset: r.video?.path ? RAW.namnqBase + r.video.path : null,
    }));
    pools.namnq = makeNamePool(records);
    stats.namnq = { list: records.length, ...pools.namnq.stats };
    pools.namnq.count = records.length;
  }

  // 4. omercotkd — joined on openGym's own exercise id, not on the name (the CSV ids ARE
  // openGym ids). Only named exercises take part: variantOf pointers inherit instead.
  {
    const text = await fetchText(SOURCES[4].url);
    const rows = parseCsv(text);
    const header = rows[0];
    const idIdx = header.indexOf('id');
    const nameIdx = header.indexOf('name');
    const byId = new Map();
    const assetOwner = new Map(); // asset -> normalised name
    let skippedNoAsset = 0, skippedAssetConflict = 0, skippedDuplicate = 0;
    const nameAgreement = [];
    for (const row of rows.slice(1)) {
      const id = row[idIdx];
      const name = row[nameIdx];
      if (!id || byId.has(id)) { skippedDuplicate++; continue; }
      const normName = normalise(name);
      byId.set(id, { ref: id, normName, asset: `${RAW.omercotkdBase}assets/${id}.gif` });
      nameAgreement.push({ id, csvName: name });
      const owner = assetOwner.get(byId.get(id).asset);
      if (owner !== undefined && owner !== normName) skippedAssetConflict++;
      else assetOwner.set(byId.get(id).asset, normName);
    }
    pools.omercotkd = { byId, stats: { list: rows.length - 1, skippedNoAsset, skippedAssetConflict, skippedDuplicate } };
    stats.omercotkd = { list: rows.length - 1, ...pools.omercotkd.stats };
    pools.omercotkd.count = rows.length - 1;
    pools.omercotkd.nameAgreement = nameAgreement;
  }

  return { pools, stats };
}

// ---------------------------------------------------------------------------
// Cascade
// ---------------------------------------------------------------------------
function runCascade(catalogue, pools) {
  const { exercises, byId, resolve } = catalogue;
  const named = exercises.filter((e) => !e.variantOf);
  const variants = exercises.filter((e) => e.variantOf);

  const steps = [
    { key: 'repdb', lookup: (ex) => pools.repdb.byName.get(normalise(ex.name)) },
    { key: 'workout-guide', lookup: (ex) => pools['workout-guide'].byName.get(normalise(ex.name)) },
    { key: 'everkinetic', lookup: (ex) => pools.everkinetic.byName.get(normalise(ex.name)) },
    { key: 'namnq', lookup: (ex) => pools.namnq.byName.get(normalise(ex.name)) },
    { key: 'omercotkd', lookup: (ex) => pools.omercotkd.byId.get(ex.id) },
  ];

  const assigned = new Map(); // named exercise id -> { source, ref, asset }
  for (const ex of named) {
    for (const step of steps) {
      const hit = step.lookup(ex);
      if (hit) { assigned.set(ex.id, { source: step.key, ref: hit.ref, asset: hit.asset }); break; }
    }
  }
  return { assigned, named, variants, byId, resolve };
}

// ---------------------------------------------------------------------------
// Manifest assembly
// ---------------------------------------------------------------------------
function buildManifest(cascade, pools) {
  const { assigned, named, variants, byId, resolve } = cascade;

  const meta = new Map(SOURCES.map((s) => [s.key, s]));
  const entries = [];
  const uncovered = [];
  const bySource = {};
  let namedCovered = 0, variantCovered = 0;

  for (const ex of named) {
    const hit = assigned.get(ex.id);
    if (!hit) { uncovered.push(ex.id); continue; }
    namedCovered++;
    bySource[hit.source] = (bySource[hit.source] ?? 0) + 1;
    const m = meta.get(hit.source);
    entries.push({
      id: ex.id, name: ex.name, variantOf: null, source: hit.source,
      sourceRef: hit.ref, sourceAsset: hit.asset,
      kind: m.kind, licence: m.licence, obligation: m.obligation,
    });
  }
  for (const ex of variants) {
    const parent = resolve(ex.id);
    const hit = parent ? assigned.get(parent.id) : undefined;
    if (!hit) { uncovered.push(ex.id); continue; }
    variantCovered++;
    bySource[hit.source] = (bySource[hit.source] ?? 0) + 1;
    const m = meta.get(hit.source);
    entries.push({
      id: ex.id, name: parent.name, variantOf: ex.variantOf, source: hit.source,
      sourceRef: hit.ref, sourceAsset: hit.asset,
      kind: m.kind, licence: m.licence, obligation: m.obligation,
    });
  }

  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  uncovered.sort();

  const manifest = {
    generatedAt: new Date().toISOString(),
    normalisation: NORMALISATION,
    sources: SOURCES.map((s) => ({
      key: s.key, url: s.url, licence: s.licence, licenceUrl: s.licenceUrl,
      obligation: s.obligation, count: pools[s.key].count,
    })),
    summary: {
      named: named.length,
      variants: variants.length,
      covered: namedCovered + variantCovered,
      uncovered: uncovered.length,
      bySource,
    },
    entries,
    uncovered,
  };
  return { manifest, namedCovered, variantCovered };
}

// ---------------------------------------------------------------------------
// Post-run verification
// ---------------------------------------------------------------------------
function verify(manifest, cascade, pools) {
  const problems = [];
  const { summary, entries, uncovered } = manifest;

  if (summary.covered + summary.uncovered !== summary.named + summary.variants) {
    problems.push(`inconsistent summary: ${summary.covered}+${summary.uncovered} !== ${summary.named}+${summary.variants}`);
  }
  if (summary.covered !== entries.length) problems.push('summary.covered !== entries.length');
  if (summary.uncovered !== uncovered.length) problems.push('summary.uncovered !== uncovered.length');
  if (summary.named + summary.variants !== 6554) problems.push(`total ${summary.named + summary.variants} !== 6554`);
  const bySourceSum = Object.values(summary.bySource).reduce((a, b) => a + b, 0);
  if (bySourceSum !== summary.covered) problems.push(`bySource sums to ${bySourceSum}, covered is ${summary.covered}`);

  // one asset -> at most one normalised name
  const assetNames = new Map();
  const refNames = new Map();
  for (const e of entries) {
    const n = normalise(e.name);
    const prevAsset = assetNames.get(e.sourceAsset);
    if (prevAsset && prevAsset !== n) problems.push(`asset reused across names: ${e.sourceAsset} -> ${prevAsset} / ${n}`);
    assetNames.set(e.sourceAsset, n);

    const refKey = `${e.source}:${e.sourceRef}`;
    const prevRef = refNames.get(refKey);
    if (prevRef && prevRef !== n) problems.push(`source record reused across names: ${refKey} -> ${prevRef} / ${n}`);
    refNames.set(refKey, n);
  }

  // variant pointers must carry exactly their parent's resolution
  for (const e of entries.filter((x) => x.variantOf)) {
    const parent = entries.find((x) => x.id === e.variantOf);
    if (!parent) { problems.push(`variant ${e.id} has no covered parent entry`); continue; }
    if (parent.sourceAsset !== e.sourceAsset || parent.source !== e.source) {
      problems.push(`variant ${e.id} does not inherit parent ${parent.id}`);
    }
  }

  // omercotkd id join: every joined row must exist in the catalogue under the same id,
  // and the CSV name must normalise to the catalogue name (reported, not fatal: the join is by id).
  const joinDisagreements = [];
  for (const row of pools.omercotkd.nameAgreement ?? []) {
    const cat = cascade.byId.get(row.id);
    if (!cat) { problems.push(`omercotkd id ${row.id} not in catalogue`); continue; }
    if (cat.name && normalise(cat.name) !== normalise(row.csvName)) joinDisagreements.push(row.id);
  }

  return { problems, assetNames, refNames, poolStats: pools, joinDisagreements };
}

// ---------------------------------------------------------------------------
function printReport(manifest, verification, stats) {
  const { summary } = manifest;
  console.log('=== media cascade manifest ===');
  console.log(`named ${summary.named}  variants ${summary.variants}  covered ${summary.covered}  uncovered ${summary.uncovered}`);
  console.log(`bySource (manifest entries) ${JSON.stringify(summary.bySource)}`);
  console.log('source pool stats:', JSON.stringify(stats));
  console.log(`distinct assets used: ${verification.assetNames.size}  distinct source records used: ${verification.refNames.size}`);

  const bySourceEntries = new Map();
  for (const e of manifest.entries) {
    if (!bySourceEntries.has(e.source)) bySourceEntries.set(e.source, []);
    bySourceEntries.get(e.source).push(e);
  }
  console.log('\nsample entries (2 per source, lowest ids):');
  for (const source of SOURCES.map((s) => s.key)) {
    const list = bySourceEntries.get(source) ?? [];
    console.log(`  [${source}] ${list.length} entries`);
    for (const e of list.slice(0, 2)) {
      console.log(`    ${e.id} | ${e.name} | variantOf=${e.variantOf} | ref=${e.sourceRef} | ${e.kind}`);
      console.log(`      ${e.sourceAsset}`);
    }
  }

  console.log('\nverification:');
  if (verification.problems.length === 0) {
    console.log('  OK: summary consistent, no asset/record reused across two different names, variants inherit correctly');
  } else {
    for (const p of verification.problems) console.log('  FAIL: ' + p);
  }
  console.log(`  omercotkd id-join rows whose CSV name differs from the catalogue name after normalisation: ${verification.joinDisagreements.length}` +
    (verification.joinDisagreements.length ? ` (${verification.joinDisagreements.join(', ')})` : ''));
}

async function main() {
  const catalogue = loadCatalogue();
  const namedCount = catalogue.exercises.filter((e) => !e.variantOf).length;
  const variantCount = catalogue.exercises.length - namedCount;
  console.log(`catalogue: ${catalogue.exercises.length} files (${namedCount} named, ${variantCount} variant pointers)`);

  const { pools, stats } = await buildPools();
  const cascade = runCascade(catalogue, pools);
  const { manifest, namedCovered, variantCovered } = buildManifest(cascade, pools);
  const verification = verify(manifest, cascade, pools);

  if (verification.problems.length) {
    printReport(manifest, verification, stats);
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`wrote ${path.relative(REPO, OUT_FILE)} (${manifest.entries.length} entries)`);
  printReport(manifest, verification, stats);
  console.log(`\nnamed covered ${namedCovered}, variants inheriting ${variantCovered}, total ${manifest.summary.covered}`);
}

await main();
