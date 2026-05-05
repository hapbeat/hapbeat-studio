#!/usr/bin/env node
// Strip non-audio chunks (INFO/LIST/ID3/bext...) from WAV files in public/library/clips/
// Keeps only RIFF/WAVE + fmt + data chunks. Run before publishing distribution assets
// to avoid leaking author/copyright metadata embedded by the original sound effect sites.
//
// Usage:
//   node scripts/strip-wav-metadata.mjs                 # default: public/library/clips
//   node scripts/strip-wav-metadata.mjs <dir-or-file>...  # one or more dirs/files

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ARGS = process.argv.slice(2);
const TARGETS = ARGS.length ? ARGS : [join(__dirname, '..', 'public', 'library', 'clips')];

function readU32LE(buf, off) {
  return buf.readUInt32LE(off);
}

function stripWav(inPath) {
  const buf = readFileSync(inPath);
  if (buf.length < 12) throw new Error('not a WAV');
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not RIFF');
  if (buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not WAVE');

  let off = 12;
  let fmtChunk = null;
  let dataChunk = null;
  const isChunkId = (s) => /^[A-Za-z0-9 ]{4}$/.test(s);
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = readU32LE(buf, off + 4);
    const payloadStart = off + 8;
    const payloadEnd = payloadStart + size;
    if (payloadEnd > buf.length) break;
    if (id === 'fmt ') fmtChunk = buf.subarray(off, payloadEnd);
    else if (id === 'data') dataChunk = buf.subarray(off, payloadEnd);
    // skip everything else (LIST/INFO/id3 /bext/iXML etc.)
    // RIFF spec word-aligns odd-size chunks, but some writers omit the pad
    // byte. Probe both alignments and pick the one that yields a valid chunk ID.
    const padded = payloadEnd + (size % 2);
    if (size % 2 === 1
        && padded + 4 <= buf.length
        && !isChunkId(buf.toString('ascii', padded, padded + 4))
        && isChunkId(buf.toString('ascii', payloadEnd, payloadEnd + 4))) {
      off = payloadEnd; // no pad byte present
    } else {
      off = padded;
    }
  }
  if (!fmtChunk || !dataChunk) throw new Error('missing fmt/data chunk');

  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), fmtChunk, dataChunk]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length, 4);
  const out = Buffer.concat([header, body]);

  if (out.length === buf.length) return { changed: false, before: buf.length, after: out.length };
  writeFileSync(inPath, out);
  return { changed: true, before: buf.length, after: out.length };
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (extname(entry).toLowerCase() === '.wav') out.push(p);
  }
  return out;
}

const files = [];
for (const t of TARGETS) {
  let st;
  try { st = statSync(t); } catch { console.warn(`skip ${t}: not found`); continue; }
  if (st.isDirectory()) files.push(...walk(t));
  else if (extname(t).toLowerCase() === '.wav') files.push(t);
}
let stripped = 0;
for (const f of files) {
  try {
    const r = stripWav(f);
    if (r.changed) {
      stripped++;
      console.log(`stripped: ${f}  ${r.before} -> ${r.after} bytes`);
    }
  } catch (e) {
    console.warn(`skip ${f}: ${e.message}`);
  }
}
console.log(`done. ${stripped}/${files.length} files modified.`);
