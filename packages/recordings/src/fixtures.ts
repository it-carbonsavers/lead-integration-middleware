/**
 * Generates a short, valid WAV file (mono, 8 kHz, 16-bit tone). Used by tests and the local
 * recording simulator; no real call audio exists anywhere in the project.
 */
export function makeTestWav(seconds = 1, frequencyHz = 440, seed = 0): Buffer {
  const sampleRate = 8_000;
  const samples = Math.max(1, Math.floor(seconds * sampleRate));
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate + seed) * 8_000);
    data.writeInt16LE(v, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
