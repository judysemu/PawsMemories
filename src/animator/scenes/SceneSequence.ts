export type InterpolationType = 'linear' | 'step' | 'catmull-rom';

export interface Keyframe {
  timeSeconds: number;
  value: any;
  easing?: string;
  interpolation?: InterpolationType;
}

export interface TrackLane {
  id: string;
  type: 'clip' | 'viseme' | 'camera' | 'fx' | 'light' | 'sound' | 'weather';
  actorId?: string; // If applicable (clip, viseme)
  keyframes: Keyframe[];
}

export interface SceneSequence {
  id: string;
  name: string;
  version: number;
  fps: number;
  durationSeconds: number;
  lanes: TrackLane[];
}

export interface EvaluatedSequenceState {
  cameraTarget?: any;
  weatherTarget?: any;
  fxTarget?: any;
  lightTarget?: any;
  soundTarget?: any;
  clipTargets: Record<string, any>; // actorId -> clip info
  visemeTargets: Record<string, any>; // actorId -> viseme track info
}

/**
 * Catmull-Rom heuristic arc interpolation (AI in-betweening v1).
 * Calculates an interpolated value between p1 and p2 using adjacent keys p0 and p3 for velocity.
 */
export function catmullRomInterpolate(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const v0 = (p2 - p0) * 0.5;
  const v1 = (p3 - p1) * 0.5;
  const t2 = t * t;
  const t3 = t * t2;
  return (2 * p1 - 2 * p2 + v0 + v1) * t3 + (-3 * p1 + 3 * p2 - 2 * v0 - v1) * t2 + v0 * t + p1;
}

/**
 * Evaluates a sequence at a given point in time across all lanes.
 * Supports multi-actor tracks and discrete/continuous keyframes.
 */
export function evaluateSequence(
  sequence: SceneSequence,
  currentTime: number
): EvaluatedSequenceState {
  const state: EvaluatedSequenceState = {
    clipTargets: {},
    visemeTargets: {},
  };

  for (const lane of sequence.lanes) {
    let activeKeyframe: Keyframe | null = null;
    let nextKeyframe: Keyframe | null = null;

    for (let i = 0; i < lane.keyframes.length; i++) {
      if (lane.keyframes[i].timeSeconds <= currentTime) {
        activeKeyframe = lane.keyframes[i];
        nextKeyframe = lane.keyframes[i + 1] || null;
      } else {
        break;
      }
    }

    if (!activeKeyframe) continue;

    let evaluatedValue = activeKeyframe.value;

    // Optional: continuous interpolation if Catmull-Rom is requested (e.g. for camera translation)
    if (nextKeyframe && activeKeyframe.interpolation === 'catmull-rom' && typeof activeKeyframe.value === 'number') {
      const idx = lane.keyframes.indexOf(activeKeyframe);
      const p0 = lane.keyframes[Math.max(0, idx - 1)].value;
      const p1 = activeKeyframe.value;
      const p2 = nextKeyframe.value;
      const p3 = lane.keyframes[Math.min(lane.keyframes.length - 1, idx + 2)].value;
      
      const t = (currentTime - activeKeyframe.timeSeconds) / (nextKeyframe.timeSeconds - activeKeyframe.timeSeconds);
      evaluatedValue = catmullRomInterpolate(p0, p1, p2, p3, t);
    }

    if (lane.type === 'camera') state.cameraTarget = evaluatedValue;
    else if (lane.type === 'weather') state.weatherTarget = evaluatedValue;
    else if (lane.type === 'fx') state.fxTarget = evaluatedValue;
    else if (lane.type === 'light') state.lightTarget = evaluatedValue;
    else if (lane.type === 'sound') state.soundTarget = evaluatedValue;
    else if (lane.type === 'clip' && lane.actorId) {
      state.clipTargets[lane.actorId] = evaluatedValue;
    }
    else if (lane.type === 'viseme' && lane.actorId) {
      state.visemeTargets[lane.actorId] = evaluatedValue;
    }
  }

  return state;
}

/**
 * Legacy runner for older script formats.
 */
export function runScript(script: any, currentTime: number): EvaluatedSequenceState {
  let latestCamera: any = null;
  let latestLight: any = null;
  let latestSound: any = null;
  let latestWeather: any = null;
  const clipTargets: Record<string, any> = {};

  const events = Array.isArray(script?.events) ? script.events : [];
  for (const event of events) {
    const eventTime = typeof event.startTime === 'number' ? event.startTime : event.time;
    if (eventTime <= currentTime) {
      if (event.type === 'camera') latestCamera = event.value ?? { position: event.position, target: event.target, fov: event.fov };
      if (event.type === 'light') latestLight = event.value ?? { preset: event.preset, intensity: event.intensity };
      if (event.type === 'sound') latestSound = event.stopTime !== undefined && currentTime >= event.stopTime
        ? null
        : event.value ?? { assetId: event.assetId, gain: event.gain, loop: event.loop, stopTime: event.stopTime, fadeSeconds: event.fadeSeconds };
      if (event.type === 'weather') latestWeather = event.value ?? event.weather;
      if (event.type === 'clip' && event.roleId) {
        clipTargets[event.roleId] = { name: event.value ?? event.clipId, blend: event.blend ?? event.blendSeconds ?? 0 };
      }
    }
  }

  return {
    cameraTarget: latestCamera,
    lightTarget: latestLight,
    soundTarget: latestSound,
    weatherTarget: latestWeather,
    clipTargets,
    visemeTargets: {},
  };
}
