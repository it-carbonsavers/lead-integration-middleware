/**
 * Recording file rules (working assumption for open question Q13, configurable later):
 *
 *   Allowed types   .mp3  .wav  .m4a  .ogg   (content is checked by its magic bytes, not just the name)
 *   File name       <recording_ref>.<ext>                       e.g. TRX-2026-000123.mp3
 *               or  <PLATFORM>_<external_lead_id>_<YYYYMMDDTHHMMSSZ>.<ext>
 *                                                               e.g. PRV01_TRX-2026-000123_20261117T094002Z.wav
 *   Characters      letters, digits, . _ -   (max 200)
 */

export const RECORDING_EXTENSIONS = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
} as const;
export type RecordingExt = keyof typeof RECORDING_EXTENSIONS;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export interface ParsedName {
  fileName: string;
  stem: string;
  ext: RecordingExt;
}

/** Returns null when the name is not acceptable (no paths, safe characters, allowed extension). */
export function parseRecordingName(fileName: string): ParsedName | null {
  if (!NAME.test(fileName) || fileName.includes("..")) return null;
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();
  if (!(ext in RECORDING_EXTENSIONS)) return null;
  return { fileName, stem: fileName.slice(0, dot), ext: ext as RecordingExt };
}

/**
 * Detects the real audio format from the file's structure, not just its first bytes, so a file
 * that merely starts with an audio signature followed by anything else is not accepted.
 * (Not a full decoder: it checks that the container/frame headers are well formed.)
 */
export function detectAudio(data: Buffer): RecordingExt | null {
  if (data.length < 12) return null;
  if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WAVE")
    return isWav(data) ? "wav" : null;
  if (data.toString("ascii", 0, 3) === "ID3") return isId3Mp3(data) ? "mp3" : null;
  if (isMpegFrame(data, 0)) return "mp3";
  if (data.toString("ascii", 4, 8) === "ftyp") return isMp4(data) ? "m4a" : null;
  if (data.toString("ascii", 0, 4) === "OggS")
    return data[4] === 0 && data.length >= 27 ? "ogg" : null;
  return null;
}

/** RIFF/WAVE: a valid 'fmt ' chunk (PCM or other known format) and a 'data' chunk. */
function isWav(d: Buffer): boolean {
  let off = 12;
  let fmt = false;
  while (off + 8 <= d.length && off < 1_048_576) {
    const id = d.toString("ascii", off, off + 4);
    const size = d.readUInt32LE(off + 4);
    if (id === "fmt ") {
      if (size < 16 || off + 8 + 16 > d.length) return false;
      const channels = d.readUInt16LE(off + 10);
      const sampleRate = d.readUInt32LE(off + 12);
      const bits = d.readUInt16LE(off + 22);
      if (channels < 1 || channels > 16 || sampleRate < 1000 || sampleRate > 384_000) return false;
      if (bits === 0 || bits > 64) return false;
      fmt = true;
    } else if (id === "data") {
      return fmt && size > 0;
    }
    if (!/^[\x20-\x7e]{4}$/.test(id)) return false;
    off += 8 + size + (size % 2);
  }
  return false;
}

/** MPEG audio frame header: sync bits plus no reserved version, layer, bitrate or sample rate. */
function isMpegFrame(d: Buffer, off: number): boolean {
  if (off + 4 > d.length) return false;
  if (d[off] !== 0xff || (d[off + 1]! & 0xe0) !== 0xe0) return false;
  const version = (d[off + 1]! >> 3) & 0b11;
  const layer = (d[off + 1]! >> 1) & 0b11;
  const bitrate = (d[off + 2]! >> 4) & 0b1111;
  const rate = (d[off + 2]! >> 2) & 0b11;
  return version !== 0b01 && layer !== 0b00 && bitrate !== 0b1111 && bitrate !== 0 && rate !== 0b11;
}

/** ID3v2 tag (valid header and size), followed by an MPEG frame. */
function isId3Mp3(d: Buffer): boolean {
  if (d.length < 14 || d[3]! > 4 || d[3]! < 2) return false;
  if ([6, 7, 8, 9].some((i) => d[i]! & 0x80)) return false; // size is "synchsafe" (7 bits per byte)
  const size = ((d[6]! << 21) | (d[7]! << 14) | (d[8]! << 7) | d[9]!) + 10;
  return isMpegFrame(d, size);
}

/** ISO base media (m4a): a sane 'ftyp' box followed by another box. */
function isMp4(d: Buffer): boolean {
  const size = d.readUInt32BE(0);
  if (size < 16 || size > 4096 || size + 8 > d.length) return false;
  const next = d.readUInt32BE(size);
  return next >= 8 && /^[a-z0-9 ]{4}$/i.test(d.toString("ascii", size + 4, size + 8));
}

export interface NamingMatch {
  kind: "recording_ref" | "naming_convention";
  value: string;
}

/** Candidate identifiers a file name can refer to, in order of preference. */
export function matchCandidates(stem: string, platformCode: string): NamingMatch[] {
  const out: NamingMatch[] = [{ kind: "recording_ref", value: stem }];
  const m = new RegExp(`^${platformCode}_(.+)_(\\d{8}T\\d{6}Z)$`).exec(stem);
  if (m) out.push({ kind: "naming_convention", value: m[1]! });
  return out;
}

/** OpenSSH-style SHA256 fingerprint of a raw public host key. */
export async function sshFingerprint(rawKey: Buffer): Promise<string> {
  const { createHash } = await import("node:crypto");
  return `SHA256:${createHash("sha256").update(rawKey).digest("base64").replace(/=+$/, "")}`;
}
