// Git object model and packfile codec for the forge.
//
// Everything here is implemented from the git object format itself, using only
// node:crypto (SHA-1) and node:zlib: loose objects live in a Map, packfiles are
// read and written in the v2 format, and deltas (OFS_DELTA / REF_DELTA) are
// resolved against the pack or against objects the repository already holds.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

const OID_RE = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return OID_RE.test(value);
}

/** The SHA-1 id git assigns to an object of `type` holding `data`. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store one object, returning its id (a no-op when it is already present). */
export function putObject(store: Map<string, GitObject>, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** git's tree sort: directories compare as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Encode a tree object from its entries (sorted git's way). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object's entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const nul = data.indexOf(0, offset);
    if (nul < 0) break;
    const head = data.subarray(offset, nul).toString('utf8');
    const space = head.indexOf(' ');
    const mode = head.slice(0, space);
    const name = head.slice(space + 1);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's fields. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Encode a commit object. */
export function buildCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Encode an annotated tag object. */
export function buildTag(info: TagInfo): Buffer {
  return Buffer.from(`object ${info.object}\ntype ${info.type}\ntag ${info.tag}\ntagger ${info.tagger}\n\n${info.message}`, 'utf8');
}

/**
 * Flatten a tree (recursively) into path -> {mode, oid} for one commit's tree.
 * Missing trees or blobs are skipped rather than throwing: a corrupt client
 * object must not take the whole server down.
 */
export function flattenTree(store: Map<string, GitObject>, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
  const obj = store.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Build a tree object from a flat path map, creating intermediate trees. */
export function treeFromFiles(store: Map<string, GitObject>, files: Map<string, { mode: string; oid: string }>): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = make();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(store, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Every object reachable from `tips` (commits, their trees and blobs, tags). */
export function collectReachable(store: Map<string, GitObject>, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = store.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      stack.push(info.tree);
      for (const parent of info.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` (or they are equal). */
export function isAncestor(store: Map<string, GitObject>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

/** The first-parent chain from a commit, newest first (bounded for safety). */
export function commitChain(store: Map<string, GitObject>, tip: string, limit = 10000): string[] {
  const chain: string[] = [];
  let current: string | undefined = tip;
  const seen = new Set<string>();
  while (current !== undefined && chain.length < limit && !seen.has(current)) {
    const obj = store.get(current);
    if (obj === undefined || obj.type !== 'commit') break;
    seen.add(current);
    chain.push(current);
    current = parseCommit(obj.data).parents[0];
  }
  return chain;
}

// ---------------------------------------------------------------- packfiles

const PACK_SIGNATURE = 0x5041434b; // 'PACK'

interface PackObjectHeader {
  type: number; // 1 commit, 2 tree, 3 blob, 4 tag, 6 ofs-delta, 7 ref-delta
  size: number;
  headerLength: number;
}

function readPackObjectHeader(data: Buffer, offset: number): PackObjectHeader {
  let byte = data[offset] as number;
  const type = (byte >> 4) & 0x7;
  let size = byte & 0x0f;
  let shift = 4;
  let length = 1;
  while ((byte & 0x80) !== 0) {
    byte = data[offset + length] as number;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    length += 1;
  }
  return { type, size, headerLength: length };
}

const PACK_TYPE_NAMES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Apply a git delta (copy/insert instructions) to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size does not match the base object');
  const parts: Buffer[] = [];
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          copyOffset |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          copySize |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
    } else {
      throw new Error('delta instruction 0 is invalid');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== resultSize) throw new Error('delta result size does not match');
  return out;
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Adler-32 (RFC 1950) of a buffer, chunked so the accumulators stay small. */
function adler32(data: Buffer): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 4096) {
    const end = Math.min(data.length, i + 4096);
    for (let j = i; j < end; j += 1) {
      a += data[j] as number;
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/** True when the bytes at `offset` could start a pack object header. */
function plausiblePackHeader(pack: Buffer, offset: number): boolean {
  if (offset >= pack.length) return false;
  const type = ((pack[offset] as number) >> 4) & 0x7;
  if (type !== 1 && type !== 2 && type !== 3 && type !== 4 && type !== 6 && type !== 7) return false;
  let pos = offset;
  for (let i = 0; i < 5; i += 1) {
    if (pos >= pack.length) return false;
    if (((pack[pos] as number) & 0x80) === 0) return true;
    pos += 1;
  }
  return false;
}

/**
 * Inflate one zlib stream starting at `start`, returning the inflated bytes
 * and the offset just past the stream.
 *
 * Node's inflateSync ignores trailing bytes, so one inflate of the whole
 * remainder yields the data — but not where the stream ends. The stream's
 * last 4 bytes are the Adler-32 of the inflated data (RFC 1950), so the end
 * is found by searching for those 4 bytes (Buffer.indexOf, C speed) instead
 * of binary-searching with throwing probes. A candidate end is accepted
 * only when the next bytes plausibly start another object header (or the
 * pack ends there); anything odd falls back to the old binary search.
 */
function inflateAt(pack: Buffer, start: number, expectedSize: number, endLimit: number): { data: Buffer; end: number } {
  try {
    const data = inflateSync(pack.subarray(start, endLimit));
    if (data.length === expectedSize) {
      const trailer = Buffer.alloc(4);
      trailer.writeUInt32BE(adler32(data), 0);
      const at = pack.indexOf(trailer, start);
      if (at >= 0 && at + 4 <= endLimit) {
        const end = at + 4;
        if (end === endLimit || plausiblePackHeader(pack, end)) return { data, end };
      }
    }
  } catch {
    // Fall through to the binary search below.
  }
  let low = start + 1;
  let high = endLimit;
  let found: { data: Buffer; end: number } | null = null;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    try {
      const data = inflateSync(pack.subarray(start, mid));
      found = { data, end: mid };
      high = mid - 1;
    } catch {
      low = mid + 1;
    }
  }
  if (found === null) throw new Error('could not inflate a pack object');
  return found;
}

/**
 * Read a packfile (v2/v3). Delta bases resolve from the pack itself, or from
 * `resolveBase` (objects the repository already holds, for thin packs).
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): ReadPackResult {
  if (pack.length < 12 || pack.readUInt32BE(0) !== PACK_SIGNATURE) throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  interface RawEntry {
    offset: number;
    type: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  let deltaCount = 0;
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    const header = readPackObjectHeader(pack, offset);
    offset += header.headerLength;
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (header.type === 6) {
      let byte = pack[offset] as number;
      offset += 1;
      let value = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = pack[offset] as number;
        offset += 1;
        value = ((value + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - value;
      deltaCount += 1;
    } else if (header.type === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      deltaCount += 1;
    }
    const { data, end } = inflateAt(pack, offset, header.size, pack.length - 20);
    offset = end;
    raw.push({ offset: start, type: header.type, data, baseOffset, baseOid });
  }
  const byOffset = new Map<number, GitObject>();
  const objects = new Map<string, GitObject>();
  const resolveEntry = (entry: RawEntry, depth = 0): GitObject => {
    if (depth > 100) throw new Error('delta chain too deep');
    const cached = byOffset.get(entry.offset);
    if (cached !== undefined) return cached;
    let resolved: GitObject;
    if (entry.type >= 1 && entry.type <= 4) {
      resolved = { type: PACK_TYPE_NAMES[entry.type] as GitObjectType, data: entry.data };
    } else if (entry.type === 6 || entry.type === 7) {
      let base: GitObject | undefined;
      if (entry.baseOffset !== undefined) {
        const baseEntry = raw.find((candidate) => candidate.offset === entry.baseOffset);
        if (baseEntry === undefined) throw new Error('OFS_DELTA base not found in pack');
        base = resolveEntry(baseEntry, depth + 1);
      } else if (entry.baseOid !== undefined) {
        const baseEntry = raw.find((candidate) => hashObject(PACK_TYPE_NAMES[candidate.type] as GitObjectType, candidate.data) === entry.baseOid);
        if (baseEntry !== undefined) base = resolveEntry(baseEntry, depth + 1);
        else if (resolveBase !== undefined) base = resolveBase(entry.baseOid);
        if (base === undefined) throw new Error(`REF_DELTA base ${entry.baseOid} not found`);
      } else {
        throw new Error('delta entry without a base');
      }
      resolved = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      throw new Error(`unknown pack object type ${entry.type}`);
    }
    byOffset.set(entry.offset, resolved);
    const oid = hashObject(resolved.type, resolved.data);
    if (!objects.has(oid)) objects.set(oid, resolved);
    return resolved;
  };
  for (const entry of raw) resolveEntry(entry);
  return { objects, deltaCount };
}

/** Write a packfile (v2) of plain objects — no deltas, always valid. */
const WRITE_PACK_TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function writePack(objects: readonly { type: GitObjectType; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    const typeCode = WRITE_PACK_TYPE_CODES[object.type] as number;
    const size = object.data.length;
    const headerBytes: number[] = [];
    let remaining = size;
    let first = (typeCode << 4) | (remaining & 0x0f);
    remaining >>>= 4;
    while (remaining > 0) {
      headerBytes.push(first | 0x80);
      first = remaining & 0x7f;
      remaining >>>= 7;
    }
    headerBytes.push(first);
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Verify a packfile's trailing checksum. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  if (pack.length < 20) return { ok: false, expected: '', actual: '' };
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return { ok: actual === expected, expected, actual };
}

// ---------------------------------------------------------------- pkt-lines

/** Encode one pkt-line (payload + 4-byte hex length). */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > 65520) throw new Error('pkt-line payload too large');
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Encode a sequence of pkt-lines, 'flush' / 'delim' / 'response-end' markers. */
export function pktLines(items: readonly (string | Buffer | 'flush' | 'delim' | 'response-end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else if (item === 'response-end') parts.push(PKT_RESPONSE_END);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export type DecodedPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode every pkt-line in a buffer (a complete request body). */
export function decodePktLines(buffer: Buffer): { packets: DecodedPacket[]; rest: Buffer } {
  const packets: DecodedPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const length = parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) break;
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

/** Wrap bytes into side-band-64k packets (band 1), each at most 65516 bytes. */
export function sidebandPackets(band: number, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const maxPayload = 65520 - 4 - 1;
  if (data.length === 0) {
    parts.push(pktLine(Buffer.from([band])));
    return Buffer.concat(parts);
  }
  for (let offset = 0; offset < data.length; offset += maxPayload) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + maxPayload));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(parts);
}
