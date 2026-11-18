import { describe, expect, it } from "vitest";
import { detectAudio, makeTestWav } from "../src/index.js";

const mp3Frame = [0xff, 0xfb, 0x90, 0x64]; // MPEG-1 Layer III, 128 kbit/s, 44.1 kHz

describe("audio content check", () => {
  it("accepts well-formed audio", () => {
    expect(detectAudio(makeTestWav(0.2))).toBe("wav");
    expect(detectAudio(Buffer.from([...mp3Frame, ...new Array(20).fill(0)]))).toBe("mp3");
    expect(detectAudio(Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, ...mp3Frame]))).toBe(
      "mp3",
    );
    const m4a = Buffer.alloc(40);
    m4a.writeUInt32BE(20, 0);
    m4a.write("ftypM4A ", 4, "ascii");
    m4a.writeUInt32BE(20, 20);
    m4a.write("moov", 24, "ascii");
    expect(detectAudio(m4a)).toBe("m4a");
    const ogg = Buffer.alloc(30);
    ogg.write("OggS", 0, "ascii");
    expect(detectAudio(ogg)).toBe("ogg");
  });

  it("rejects files that only start with an audio signature", () => {
    expect(detectAudio(Buffer.from("RIFFxxxxWAVE not really audio at all"))).toBeNull();
    const noData = makeTestWav(0.1).subarray(0, 36); // header and fmt chunk, no data chunk
    expect(detectAudio(noData)).toBeNull();
    const badFmt = Buffer.from(makeTestWav(0.1));
    badFmt.writeUInt32LE(5, 24); // 5 Hz sample rate
    expect(detectAudio(badFmt)).toBeNull();
    expect(
      detectAudio(Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4])),
    ).toBeNull();
    expect(detectAudio(Buffer.from([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(detectAudio(Buffer.from("xxxxftypjunk-------------"))).toBeNull();
    expect(detectAudio(Buffer.from("<html><body>not audio</body></html>"))).toBeNull();
  });
});
