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
   * Joyful short Mexican Mariachi trumpet + guitar major fanfare when tapping TAQUERIA.
   */
  public playMariachiFanfare() {
    const ctx = this.ensureReady();
    if (!ctx) return;

    const base = ctx.currentTime;

    // Bright Mariachi duet trumpets in major thirds (G major / C major festive cadence)
    const notes: Array<{ f1: number; f2: number; start: number; dur: number }> = [
      { f1: 523.25, f2: 659.25, start: 0.0, dur: 0.14 }, // C5 + E5
      { f1: 587.33, f2: 739.99, start: 0.15, dur: 0.14 }, // D5 + F#5
      { f1: 659.25, f2: 783.99, start: 0.3, dur: 0.16 }, // E5 + G5
      { f1: 783.99, f2: 987.77, start: 0.48, dur: 0.14 }, // G5 + B5
      { f1: 659.25, f2: 783.99, start: 0.64, dur: 0.13 }, // E5 + G5
      { f1: 783.99, f2: 1046.5, start: 0.79, dur: 0.48 }, // G5 + C6 triumphant finish!
    ];

    for (const n of notes) {
      const t0 = base + n.start;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(2800, t0);
      filter.Q.setValueAtTime(2.0, t0);

      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.linearRampToValueAtTime(0.11, t0 + 0.02);
      env.gain.setValueAtTime(0.095, t0 + n.dur - 0.03);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + n.dur);

      filter.connect(env);
      env.connect(ctx.destination);

      // Gentle vibrato on final held note
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.setValueAtTime(6.0, t0);
      lfoGain.gain.setValueAtTime(n.dur > 0.3 ? 6 : 0, t0);
      lfo.connect(lfoGain);

      const o1 = ctx.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.setValueAtTime(n.f1, t0);
      lfoGain.connect(o1.frequency);

      const o2 = ctx.createOscillator();
      o2.type = 'sawtooth';
      o2.frequency.setValueAtTime(n.f2, t0);
      lfoGain.connect(o2.frequency);

      o1.connect(filter);
      o2.connect(filter);

      lfo.start(t0);
      o1.start(t0);
      o2.start(t0);
      lfo.stop(t0 + n.dur + 0.02);
      o1.stop(t0 + n.dur + 0.02);
      o2.stop(t0 + n.dur + 0.02);
    }

    // Rhythmic guitar/vihuela major chord strums ("ta-ka-ta!")
    const strums: Array<{ freqs: number[]; start: number; dur: number }> = [
      { freqs: [261.63, 329.63, 392.0], start: 0.0, dur: 0.24 }, // C major
      { freqs: [293.66, 392.0, 493.88], start: 0.32, dur: 0.2 }, // G major
      { freqs: [261.63, 329.63, 392.0, 523.25], start: 0.79, dur: 0.52 }, // C major
    ];

    for (const s of strums) {
      s.freqs.forEach((freq, idx) => {
        const t0 = base + s.start + idx * 0.018;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t0);
        env.gain.linearRampToValueAtTime(0.055, t0 + 0.01);
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + s.dur);
        env.connect(ctx.destination);

        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, t0);
        osc.connect(env);
        osc.start(t0);
        osc.stop(t0 + s.dur + 0.02);
      });
    }
  }

  /**
   * Sci-fi modulated theremin flyby whistle for the rare UFO pass.
   */
  public playUfoTheremin() {
    const ctx = this.ensureReady();
    if (!ctx) return;

    const t = ctx.currentTime;
    const dur = 1.45;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.14, t + 0.25);
    env.gain.setValueAtTime(0.13, t + 0.95);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    env.connect(ctx.destination);

    // Classic theremin pitch sweep + fast sci-fi LFO wobble
    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.setValueAtTime(520, t);
    carrier.frequency.exponentialRampToValueAtTime(1280, t + 0.55);
    carrier.frequency.exponentialRampToValueAtTime(420, t + dur);

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(11.5, t);
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.setValueAtTime(55, t);

    lfo.connect(lfoDepth);
    lfoDepth.connect(carrier.frequency);
    carrier.connect(env);

    lfo.start(t);
    carrier.start(t);
    lfo.stop(t + dur + 0.03);
    carrier.stop(t + dur + 0.03);
  }

  /**
   * Deep V-Twin Harley-Davidson engine rumble + festive sleigh bell jingle when tapping Santa.
   */
  public playSantaHarley() {
    const ctx = this.ensureReady();
    if (!ctx) return;

    const t = ctx.currentTime;
    const dur = 1.25;

    // 1. Low V-Twin chopper exhaust rumble ("potato-potato-rev")
    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.setValueAtTime(240, t);
    rumbleFilter.frequency.linearRampToValueAtTime(420, t + 0.45);
    rumbleFilter.frequency.linearRampToValueAtTime(210, t + dur);
    rumbleFilter.Q.setValueAtTime(3.2, t);

    const rumbleEnv = ctx.createGain();
    rumbleEnv.gain.setValueAtTime(0.0001, t);
    rumbleEnv.gain.linearRampToValueAtTime(0.24, t + 0.06);
    rumbleEnv.gain.setValueAtTime(0.2, t + 0.75);
    rumbleEnv.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    rumbleFilter.connect(rumbleEnv);
    rumbleEnv.connect(ctx.destination);

    // Dual slightly detuned low sawtooths for uneven V-Twin throb
    const eng1 = ctx.createOscillator();
    eng1.type = 'sawtooth';
    eng1.frequency.setValueAtTime(52, t);
    eng1.frequency.linearRampToValueAtTime(86, t + 0.42);
    eng1.frequency.linearRampToValueAtTime(54, t + dur);

    const eng2 = ctx.createOscillator();
    eng2.type = 'triangle';
    eng2.frequency.setValueAtTime(39, t);
    eng2.frequency.linearRampToValueAtTime(64, t + 0.42);
    eng2.frequency.linearRampToValueAtTime(41, t + dur);

    // Chug LFO modulating filter frequency
    const chugLfo = ctx.createOscillator();
    chugLfo.type = 'sine';
    chugLfo.frequency.setValueAtTime(14, t);
    const chugDepth = ctx.createGain();
    chugDepth.gain.setValueAtTime(85, t);
    chugLfo.connect(chugDepth);
    chugDepth.connect(rumbleFilter.frequency);

    eng1.connect(rumbleFilter);
    eng2.connect(rumbleFilter);
    chugLfo.start(t);
    eng1.start(t);
    eng2.start(t);
    chugLfo.stop(t + dur + 0.02);
    eng1.stop(t + dur + 0.02);
    eng2.stop(t + dur + 0.02);

    // 2. Cheerful sleigh bell jingle accents
    const bellOffsets = [0.12, 0.34, 0.56];
    for (const off of bellOffsets) {
      const tb = t + off;
      const bellGain = ctx.createGain();
      bellGain.gain.setValueAtTime(0.0001, tb);
      bellGain.gain.linearRampToValueAtTime(0.075, tb + 0.008);
      bellGain.gain.exponentialRampToValueAtTime(0.0001, tb + 0.24);
      bellGain.connect(ctx.destination);

      for (const freq of [2637, 3322, 4186]) {
        const bellOsc = ctx.createOscillator();
        bellOsc.type = 'sine';
        bellOsc.frequency.setValueAtTime(freq, tb);
        bellOsc.connect(bellGain);
        bellOsc.start(tb);
        bellOsc.stop(tb + 0.25);
      }
    }
  }

  public dispose() {
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}
