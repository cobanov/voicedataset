// Microphone tap. Posts the input level about 60 times a second, and while recording,
// the raw samples of the first input channel in blocks of 4096.
class Tap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.blocks = 0;
    this.pk = 0;
    this.port.onmessage = (e) => {
      if (e.data === "start") {
        this.n = 0;
        this.on = true;
      } else if (e.data === "stop") {
        this.flush();
        this.on = false;
        this.port.postMessage({ stopped: true });
      }
    };
  }

  flush() {
    if (!this.n) return;
    const out = this.buf.slice(0, this.n);
    this.port.postMessage({ buf: out }, [out.buffer]);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let pk = this.pk;
      for (let i = 0; i < ch.length; i++) {
        const v = ch[i] < 0 ? -ch[i] : ch[i];
        if (v > pk) pk = v;
      }
      this.pk = pk;
      if (this.on) {
        let i = 0;
        while (i < ch.length) {
          const k = Math.min(ch.length - i, this.buf.length - this.n);
          this.buf.set(ch.subarray(i, i + k), this.n);
          this.n += k;
          i += k;
          if (this.n === this.buf.length) this.flush();
        }
      }
      if (++this.blocks % 6 === 0) {
        this.port.postMessage({ pk: this.pk });
        this.pk = 0;
      }
    }
    return true;
  }
}

registerProcessor("tap", Tap);
