"use client";

let context: AudioContext | null = null;
let openingPlayed = false;

function getAudioContext() {
  if (typeof window === "undefined") return null;

  const BrowserAudioContext =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!BrowserAudioContext) return null;

  if (!context || context.state === "closed") context = new BrowserAudioContext();
  return context;
}

function note(
  audio: AudioContext,
  frequency: number,
  start: number,
  duration: number,
  volume: number,
  type: OscillatorType = "sine",
) {
  const oscillator = audio.createOscillator();
  const envelope = audio.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(volume, start + 0.018);
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(envelope);
  envelope.connect(audio.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function play(sequence: (audio: AudioContext, start: number) => void) {
  try {
    const audio = getAudioContext();
    if (!audio) return;
    void audio
      .resume()
      .then(() => {
        if (audio.state === "running") sequence(audio, audio.currentTime + 0.015);
      })
      .catch(() => {
        // Browsers may block playback before a user gesture.
      });
  } catch {
    // Keep the visual interaction usable when audio is unavailable.
  }
}

export function playOpeningCue(signal?: AbortSignal) {
  if (openingPlayed || signal?.aborted) return;

  play((audio, start) => {
    if (openingPlayed || signal?.aborted) return;
    openingPlayed = true;
    // A short, upbeat four-note signature under the color sweep.
    for (const [offset, frequency] of [
      [0, 392],
      [0.16, 523.25],
      [0.32, 659.25],
      [0.52, 783.99],
    ]) {
      note(audio, frequency, start + offset, 0.42, 0.048, "triangle");
      note(audio, frequency * 2, start + offset, 0.28, 0.012);
    }
    note(audio, 196, start, 1.28, 0.018);
    note(audio, 293.66, start + 0.16, 1.04, 0.012);
    // A soft resolving chord follows the return sweep into the app theme.
    note(audio, 261.63, start + 1.22, 1.12, 0.016, "triangle");
    note(audio, 523.25, start + 1.36, 0.84, 0.019);
    note(audio, 783.99, start + 1.5, 0.62, 0.016);
  });
}

export function playThemeCue(theme: "light" | "dark") {
  play((audio, start) => {
    if (theme === "light") {
      note(audio, 659.25, start, 0.22, 0.04, "triangle");
      note(audio, 987.77, start + 0.11, 0.34, 0.045);
    } else {
      note(audio, 392, start, 0.25, 0.042, "triangle");
      note(audio, 261.63, start + 0.1, 0.36, 0.036);
    }
  });
}
