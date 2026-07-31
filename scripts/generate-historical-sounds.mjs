import fs from "node:fs";
import path from "node:path";

const SAMPLE_RATE = 22_050;

const definitions = [
  { file: "composer-chamber-motif-v1.wav", duration: 4, render: chamberMotif },
  { file: "naturalist-woodland-ambience-v1.wav", duration: 4, render: woodlandAmbience },
  { file: "novelist-page-pen-v1.wav", duration: 3, render: pageAndPen },
  { file: "healer-lamp-bell-v1.wav", duration: 3, render: lampBell },
];

function clamp(sample) {
  return Math.max(-1, Math.min(1, sample));
}

function envelope(t, duration, attack = 0.02, release = 0.18) {
  return Math.min(1, t / attack, Math.max(0, (duration - t) / release));
}

function tone(t, frequency, duration, gain = 1) {
  if (t < 0 || t >= duration) return 0;
  return Math.sin(2 * Math.PI * frequency * t) * envelope(t, duration) * gain;
}

function hashNoise(index) {
  let value = (index + 1) * 0x45d9f3b;
  value = ((value >>> 16) ^ value) * 0x45d9f3b;
  value = ((value >>> 16) ^ value) >>> 0;
  return (value / 0xffffffff) * 2 - 1;
}

function chamberMotif(t) {
  const notes = [261.63, 329.63, 392, 329.63, 293.66, 349.23, 440, 392];
  const beat = 0.5;
  const index = Math.floor(t / beat) % notes.length;
  const local = t - Math.floor(t / beat) * beat;
  return tone(local, notes[index], 0.42, 0.18) + tone(local, notes[index] * 2, 0.34, 0.035);
}

function woodlandAmbience(t, index) {
  const breeze = hashNoise(Math.floor(index / 7)) * 0.035 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.22 * t));
  const birdA = tone(t - 0.7, 880 + 90 * (t - 0.7), 0.18, 0.1);
  const birdB = tone(t - 2.55, 1046 + 65 * (t - 2.55), 0.16, 0.08);
  return breeze + birdA + birdB;
}

function pageAndPen(t, index) {
  const strokePhase = t % 0.22;
  const pen = strokePhase < 0.12 ? hashNoise(index) * (1 - strokePhase / 0.12) * 0.055 : 0;
  const page = t > 2.15 && t < 2.55 ? hashNoise(Math.floor(index / 2)) * Math.sin(Math.PI * (t - 2.15) / 0.4) * 0.12 : 0;
  return pen + page;
}

function lampBell(t) {
  const strike = tone(t - 0.4, 659.25, 1.5, 0.16) + tone(t - 0.4, 988.88, 1.1, 0.08);
  const glow = tone(t, 110, 3, 0.015) + tone(t, 165, 3, 0.01);
  return strike * Math.exp(-Math.max(0, t - 0.4) * 2.2) + glow;
}

function wavBytes(duration, render) {
  const sampleCount = Math.round(duration * SAMPLE_RATE);
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const t = index / SAMPLE_RATE;
    buffer.writeInt16LE(Math.round(clamp(render(t, index)) * 32767), 44 + index * 2);
  }
  return buffer;
}

const outputDir = path.resolve(process.argv[2] || path.join(process.cwd(), "public/animator-files/sounds"));
fs.mkdirSync(outputDir, { recursive: true });
for (const definition of definitions) {
  fs.writeFileSync(path.join(outputDir, definition.file), wavBytes(definition.duration, definition.render));
}
