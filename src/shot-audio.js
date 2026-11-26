export class ShotAudio {
  constructor(onError) {
    this.onError = onError;
    this.context = null;
    this.disabled = false;
  }

  unlock() {
    if (this.disabled) return;
    if (!this.context) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) {
        this.disabled = true;
        this.onError('Web Audio is not supported by this browser.');
        return;
      }
      try {
        this.context = new AudioContext();
      } catch (error) {
        this.disabled = true;
        this.onError('Could not start audio: ' + error.message);
        return;
      }
      const context = this.context;
      this.buffer = context.createBuffer(1, Math.ceil(context.sampleRate * 0.08), context.sampleRate);
      const samples = this.buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) {
        const t = i / context.sampleRate;
        const attack = Math.min(1, t * 1200);
        const click = Math.exp(-t * 75);
        const spring = t > 0.028 ? Math.exp(-(t - 0.028) * 100) * 0.3 : 0;
        samples[i] = attack * (click + spring) *
          ((Math.random() * 2 - 1) * 0.65 + Math.sin(2 * Math.PI * 650 * t) * 0.35);
      }
    }
    if (this.context.state === 'suspended') {
      this.context.resume().catch((error) => this.onError('Could not resume audio: ' + error.message));
    }
  }

  play() {
    if (!this.context || this.disabled) return;
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    source.buffer = this.buffer;
    gain.gain.value = 0.18;
    source.connect(gain);
    gain.connect(this.context.destination);
    source.start();
  }
}
