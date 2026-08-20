// Lightweight notification sound using the Web Audio API — no external files.
// Plays a short, gentle two-tone chime (C5 → E5) that's pleasant but not
// jarring.  Designed to be called from an event handler so the AudioContext
// is created inside a user gesture (required by browsers).

let ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

/** Play a soft notification chime. Safe to call repeatedly — throttled internally. */
let lastPlay = 0;
export function playNotifSound() {
  const now = Date.now();
  if (now - lastPlay < 400) return; // debounce rapid-fire notifications
  lastPlay = now;

  try {
    const ac = getCtx();
    const t = ac.currentTime;

    // Two short sine tones forming a gentle chime.
    const notes = [
      { freq: 523.25, start: 0, dur: 0.12 }, // C5
      { freq: 659.25, start: 0.08, dur: 0.18 }, // E5
    ];

    for (const n of notes) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "sine";
      osc.frequency.value = n.freq;
      // Soft envelope: quick attack, smooth release.
      gain.gain.setValueAtTime(0, t + n.start);
      gain.gain.linearRampToValueAtTime(0.15, t + n.start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + n.start + n.dur);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(t + n.start);
      osc.stop(t + n.start + n.dur + 0.01);
    }
  } catch {
    // AudioContext may be unavailable (e.g. in a worker); silently ignore.
  }
}
