import { promises as fs } from "node:fs";

/**
 * Click sound track, synthesised in-house.
 *
 * No ready-made sound file is used, for two reasons: someone else's file
 * carries its own licence, and a good click is actually easy to build. What
 * matters is not the sample but the shape of its decay, so the sound is shaped
 * here and can be tuned.
 */

const RATE = 44_100;

/** One click: a sharp transient that dies away at once, not a pitched "beep". */
function addClick(buf: Float32Array, start: number, strength: number) {
  const len = Math.round(RATE * 0.035);
  for (let i = 0; i < len; i++) {
    const t = i / RATE;
    const n = start + i;
    if (n >= buf.length) break;

    // Very fast decay. This is what makes it sound like hard objects
    // knocking, not like a note from an instrument.
    const decay = Math.exp(-t / 0.0075);
    // Two close high tones give a "tick" colour without sounding pitched.
    const tone =
      Math.sin(2 * Math.PI * 2400 * t) * 0.6 + Math.sin(2 * Math.PI * 3300 * t) * 0.4;
    // A little crackle at the start, imitating the button's mechanism. Kept
    // small: the crackle is random, and a large share makes every click a
    // different loudness.
    const crackle = (Math.random() * 2 - 1) * Math.exp(-t / 0.0016) * 0.18;

    buf[n] += (tone * decay + crackle) * strength;
  }
}

/**
 * Write a 16-bit mono WAV of silence the length of the video, with a click at
 * each given time.
 */
export async function writeClickTrack(
  outPath: string,
  durationMs: number,
  clickMs: number[],
): Promise<void> {
  const total = Math.max(1, Math.round((durationMs / 1000) * RATE));
  const buf = new Float32Array(total);

  for (const ms of clickMs) {
    const start = Math.round((ms / 1000) * RATE);
    if (start < 0 || start >= total) continue;
    addClick(buf, start, 0.46);
  }

  const pcm = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) {
    // Clamped, not normalised: two clicks that happen to be close together
    // must not make the rest of the track quieter.
    const v = Math.max(-1, Math.min(1, buf[i]));
    pcm.writeInt16LE(Math.round(v * 32767), i * 2);
  }

  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVE", 8);
  head.write("fmt ", 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(pcm.length, 40);

  await fs.writeFile(outPath, Buffer.concat([head, pcm]));
}
