import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import soundManifestJson from "../../../../public/animator-files/sounds/manifest.json";
import type { WeatherType } from "../weather/WeatherSystem.tsx";

type SoundCategory = "music" | "ambience" | "foley" | "voice";
type SoundAsset = { id: string; publicUrl: string; loopSafe: boolean; category: SoundCategory };
type SoundCue = string | { assetId: string; gain?: number; loop?: boolean };

interface SoundSystemProps {
  ambientSoundId?: string;
  weather: WeatherType;
  volume?: number;
  soundCue?: SoundCue | null;
  muted: boolean;
  unlocked: boolean;
  ready: boolean;
}

const SOUND_ASSETS = new Map((soundManifestJson.assets as SoundAsset[]).map((asset) => [asset.id, asset]));
const WEATHER_SOUND_IDS: Partial<Record<WeatherType, string>> = {};

export function resolveManifestSoundUrl(assetId: string | undefined): string | null {
  if (!assetId) return null;
  return SOUND_ASSETS.get(assetId)?.publicUrl || null;
}

function stopAndDisconnect(audio: THREE.Audio | null) {
  if (!audio) return;
  try { if (audio.isPlaying) audio.stop(); } catch { /* already detached */ }
  try { audio.disconnect(); } catch { /* no active node */ }
}

export function SoundSystem({ ambientSoundId, weather, volume = 0.5, soundCue, muted, unlocked, ready }: SoundSystemProps) {
  const { camera } = useThree();
  const [listener] = useState(() => new THREE.AudioListener());
  const ambientAudio = useRef<THREE.Audio | null>(null);
  const weatherAudio = useRef<THREE.Audio | null>(null);
  const cueAudio = useRef<THREE.Audio | null>(null);
  const generation = useRef({ ambient: 0, weather: 0, cue: 0 });
  const canPlay = unlocked && ready && !muted && volume > 0;

  useEffect(() => {
    camera.add(listener);
    return () => {
      generation.current.ambient += 1;
      generation.current.weather += 1;
      generation.current.cue += 1;
      stopAndDisconnect(ambientAudio.current);
      stopAndDisconnect(weatherAudio.current);
      stopAndDisconnect(cueAudio.current);
      camera.remove(listener);
    };
  }, [camera, listener]);

  useEffect(() => {
    generation.current.ambient += 1;
    const request = generation.current.ambient;
    stopAndDisconnect(ambientAudio.current);
    ambientAudio.current = null;
    const url = resolveManifestSoundUrl(ambientSoundId);
    if (!canPlay || !url) return;
    const audio = new THREE.Audio(listener);
    ambientAudio.current = audio;
    new THREE.AudioLoader().load(url, (buffer) => {
      if (request !== generation.current.ambient || !canPlay || ambientAudio.current !== audio) return stopAndDisconnect(audio);
      audio.setBuffer(buffer); audio.setLoop(true); audio.setVolume(volume); audio.play();
    }, undefined, () => { if (ambientAudio.current === audio) ambientAudio.current = null; stopAndDisconnect(audio); });
    return () => { generation.current.ambient += 1; if (ambientAudio.current === audio) ambientAudio.current = null; stopAndDisconnect(audio); };
  }, [ambientSoundId, canPlay, listener, volume]);

  useEffect(() => {
    generation.current.weather += 1;
    const request = generation.current.weather;
    stopAndDisconnect(weatherAudio.current);
    weatherAudio.current = null;
    const weatherId = WEATHER_SOUND_IDS[weather];
    const url = resolveManifestSoundUrl(weatherId);
    if (!canPlay || !url) return;
    const audio = new THREE.Audio(listener);
    weatherAudio.current = audio;
    new THREE.AudioLoader().load(url, (buffer) => {
      if (request !== generation.current.weather || !canPlay || weatherAudio.current !== audio) return stopAndDisconnect(audio);
      audio.setBuffer(buffer); audio.setLoop(true); audio.setVolume(volume * 0.7); audio.play();
    }, undefined, () => { if (weatherAudio.current === audio) weatherAudio.current = null; stopAndDisconnect(audio); });
    return () => { generation.current.weather += 1; if (weatherAudio.current === audio) weatherAudio.current = null; stopAndDisconnect(audio); };
  }, [weather, canPlay, listener, volume]);

  useEffect(() => {
    generation.current.cue += 1;
    const request = generation.current.cue;
    stopAndDisconnect(cueAudio.current);
    cueAudio.current = null;
    const cue = typeof soundCue === "string" ? { assetId: soundCue } : soundCue;
    const asset = cue ? SOUND_ASSETS.get(cue.assetId) : undefined;
    if (!canPlay || !asset) return;
    const audio = new THREE.Audio(listener);
    cueAudio.current = audio;
    new THREE.AudioLoader().load(asset.publicUrl, (buffer) => {
      if (request !== generation.current.cue || !canPlay || cueAudio.current !== audio) return stopAndDisconnect(audio);
      const loop = cue?.loop === true && asset.loopSafe;
      audio.setBuffer(buffer); audio.setLoop(loop); audio.setVolume(volume * Math.min(1, Math.max(0, cue?.gain ?? 1))); audio.play();
    }, undefined, () => { if (cueAudio.current === audio) cueAudio.current = null; stopAndDisconnect(audio); });
    return () => { generation.current.cue += 1; if (cueAudio.current === audio) cueAudio.current = null; stopAndDisconnect(audio); };
  }, [soundCue, canPlay, listener, volume]);

  return null;
}
