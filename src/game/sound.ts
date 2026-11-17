// Lightweight WebAudio synthesizer for Castle Bastion TD
class SoundManager {
  private ctx: AudioContext | null = null;
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
    this.playTone(440, 0.07, 'triangle', 0.08);
    setTimeout(() => this.playTone(620, 0.09, 'triangle', 0.07), 35);
  }

  upgrade(isSpec = false): void {
    this.playTone(isSpec ? 523 : 480, 0.08, 'sine', 0.08);
    setTimeout(() => this.playTone(isSpec ? 784 : 660, 0.12, 'triangle', 0.08), 55);
    if (isSpec) {
      setTimeout(() => this.playTone(1046, 0.16, 'triangle', 0.09), 115);
    }
  }

  boom(): void {
    this.playTone(110, 0.12, 'sawtooth', 0.05);
  }

  zap(): void {
    this.playTone(760, 0.06, 'square', 0.03);
  }

  castleHit(): void {
    this.playTone(140, 0.18, 'sawtooth', 0.09);
  }

  waveStart(): void {
    this.playTone(392, 0.09, 'triangle', 0.08);
    setTimeout(() => this.playTone(523, 0.14, 'triangle', 0.08), 75);
  }
}

export const soundFx = new SoundManager();
