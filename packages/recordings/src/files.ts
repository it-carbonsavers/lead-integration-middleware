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

/** Detects the real audio format from the first bytes of the file. */
export function detectAudio(data: Buffer): RecordingExt | null {
  if (data.length < 12) return null;
  if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WAVE")
    return "wav";
  if (data.toString("ascii", 0, 3) === "ID3") return "mp3";
  if (data[0] === 0xff && (data[1]! & 0xe0) === 0xe0) return "mp3";
  if (data.toString("ascii", 4, 8) === "ftyp") return "m4a";
  if (data.toString("ascii", 0, 4) === "OggS") return "ogg";
  return null;
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
