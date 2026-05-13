/**
 * AudioWorklet processor — replaces the deprecated ScriptProcessorNode.
 *
 * Runs in the AudioWorklet thread (separate from the main thread). Receives
 * one-channel Float32 PCM from the input bus and forwards it to the offscreen
 * document via the MessagePort. The offscreen doc then downsamples to 16kHz
 * and calls stt.pushAudio().
 *
 * This file is intentionally plain JS (no imports) — AudioWorklet processor
 * scripts run in a restricted AudioWorkletGlobalScope that does not have
 * access to browser APIs. It is served verbatim by the extension (not bundled
 * by Vite) and loaded via:
 *   await audioCtx.audioWorklet.addModule(chrome.runtime.getURL('audio-processor.js'))
 */

class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    // inputs[0] is the first input bus; inputs[0][0] is the mono channel.
    const channel = inputs[0]?.[0];
    if (channel && channel.length > 0) {
      // Transfer the underlying buffer (zero-copy) to avoid serialisation cost.
      this.port.postMessage({ pcm: channel.buffer }, [channel.buffer]);
    }
    // Return true to keep the processor alive.
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
