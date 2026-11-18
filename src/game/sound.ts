// Lightweight WebAudio synthesizer for Castle Bastion TD
class SoundManager {
  private ctx: AudioContext | null = null;
  private lastPlayed: Record<string, number> = {};
  private timers = new Set<number>();
  public muted = false;

  private ensure(): AudioContext | null {
    if (this.muted || typeof window === 'undefined') return null;
    try {
      if (!this.ctx) {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (Ctx) this.ctx = new Ctx();
      }
      if (this.ctx && this.ctx.state === 'suspended') {
        void this.ctx.resume();
      }
      return this.ctx;
    } catch {
      return null;
    }
  }

  private canPlay(key: string, minIntervalMs: number): boolean {
    const now = performance.now();
    const prev = this.lastPlayed[key] ?? 0;
    if (now - prev < minIntervalMs) return false;
    this.lastPlayed[key] = now;
    return true;
  }

  private schedule(fn: () => void, delayMs: number): void {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, delayMs);
    this.timers.add(id);
  }

  clearPending(): void {
    for (const id of this.timers) {
      window.clearTimeout(id);
    }
    this.timers.clear();
  }

  playTone(freq: number, dur = 0.08, type: OscillatorType = 'triangle', gainVal = 0.06): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(gainVal, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur);
  }

  place(): void {
    if (!this.canPlay('place', 40)) return;
    this.playTone(440, 0.07, 'triangle', 0.08);
    this.schedule(() => this.playTone(620, 0.09, 'triangle', 0.07), 35);
  }

  upgrade(isSpec = false): void {
    if (!this.canPlay('upgrade', 45)) return;
    this.playTone(isSpec ? 523 : 480, 0.08, 'sine', 0.08);
    this.schedule(() => this.playTone(isSpec ? 784 : 660, 0.12, 'triangle', 0.08), 55);
    if (isSpec) {
      this.schedule(() => this.playTone(1046, 0.16, 'triangle', 0.09), 115);
    }
  }

  boom(): void {
    if (!this.canPlay('boom', 75)) return;
    this.playTone(110, 0.12, 'sawtooth', 0.045);
  }

  zap(): void {
    if (!this.canPlay('zap', 65)) return;
    this.playTone(760, 0.06, 'square', 0.025);
  }

  castleHit(): void {
    if (!this.canPlay('castleHit', 90)) return;
    this.playTone(140, 0.18, 'sawtooth', 0.09);
  }

  waveStart(): void {
    if (!this.canPlay('waveStart', 120)) return;
    this.playTone(392, 0.09, 'triangle', 0.08);
    this.schedule(() => this.playTone(523, 0.14, 'triangle', 0.08), 75);
  }
}

export const soundFx = new SoundManager();
