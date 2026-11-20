export class SoundEngine {
  private ctx: AudioContext | null = null;
  private muted = false;
  private lastChimeAt = 0;

  public isMuted(): boolean {
    return this.muted;
  }

  public setMuted(muted: boolean) {
    this.muted = muted;
  }

  public unlock() {
    if (typeof window === 'undefined') return;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;

    if (!this.ctx) {
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
  }

  private ensureReady(): AudioContext | null {
    if (this.muted) return null;
    this.unlock();
    if (!this.ctx || this.ctx.state !== 'running') return null;
    return this.ctx;
  }

  /**
   * Light high chime when any discipline starts (throttled to max 1 per 250ms).
   */
  public playChime() {
    const nowMs = performance.now();
    if (nowMs - this.lastChimeAt < 250) return;

    const ctx = this.ensureReady();
    if (!ctx) return;
    this.lastChimeAt = nowMs;

    const t = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, t);
    master.gain.linearRampToValueAtTime(0.14, t + 0.01);
    master.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    master.connect(ctx.destination);

    // E6 + B6 crisp crystalline bell partials
    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(1318.5, t);

    const osc2 = ctx.createOscillator();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(1975.5, t);

    const osc2Gain = ctx.createGain();
    osc2Gain.gain.setValueAtTime(0.32, t);

    osc1.connect(master);
    osc2.connect(osc2Gain);
    osc2Gain.connect(master);

    osc1.start(t);
    osc2.start(t);
    osc1.stop(t + 0.32);
    osc2.stop(t + 0.32);
  }

  /**
   * Realistic short dual-tone car horn ("beep-beep") when tapping a vehicle.
   */
  public playCarHorn() {
    const ctx = this.ensureReady();
    if (!ctx) return;

    const triggerBlast = (startOffset: number, duration: number) => {
      const t0 = ctx.currentTime + startOffset;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1450, t0);
      filter.Q.setValueAtTime(1.8, t0);

      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.linearRampToValueAtTime(0.18, t0 + 0.014);
      env.gain.setValueAtTime(0.16, t0 + duration - 0.025);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

      filter.connect(env);
      env.connect(ctx.destination);

      // Classic automotive 405 Hz + 505 Hz dual-horn chord
      const oscA = ctx.createOscillator();
      oscA.type = 'sawtooth';
      oscA.frequency.setValueAtTime(405, t0);

      const oscB = ctx.createOscillator();
      oscB.type = 'sawtooth';
      oscB.frequency.setValueAtTime(505, t0);

      oscA.connect(filter);
      oscB.connect(filter);

      oscA.start(t0);
      oscB.start(t0);
      oscA.stop(t0 + duration + 0.02);
      oscB.stop(t0 + duration + 0.02);
    };

    triggerBlast(0, 0.11);
    triggerBlast(0.16, 0.19);
  }

  /**
   * 1-second two-tone police siren ("ee-oo-ee-oo") when tapping BIURO container.
   */
  public playPoliceSiren() {
    const ctx = this.ensureReady();
    if (!ctx) return;

    const t = ctx.currentTime;
    const totalDur = 1.0;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2200, t);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.18, t + 0.03);
    env.gain.setValueAtTime(0.16, t + totalDur - 0.06);
    env.gain.exponentialRampToValueAtTime(0.0001, t + totalDur);

    const osc = ctx.createOscillator();
    osc.type = 'triangle';

    // 4 alternating 250ms tones: ee (780 Hz) - oo (560 Hz) - ee (780 Hz) - oo (560 Hz)
    osc.frequency.setValueAtTime(780, t);
    osc.frequency.setValueAtTime(560, t + 0.25);
    osc.frequency.setValueAtTime(780, t + 0.5);
    osc.frequency.setValueAtTime(560, t + 0.75);

    osc.connect(filter);
    filter.connect(env);
    env.connect(ctx.destination);

    osc.start(t);
    osc.stop(t + totalDur + 0.02);
  }

  public dispose() {
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}
