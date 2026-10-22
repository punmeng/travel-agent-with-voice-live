export function mockSpeechSdk() {
  const instances = [], configs = [], streams = [];
  class Recognizer {
    static telemetry;
    static enableTelemetry(value) { Recognizer.telemetry = value; }
    constructor(config, audio) { this.config = config; this.audio = audio; this.phrases = []; instances.push(this); }
    startContinuousRecognitionAsync(success) { success(); }
    close() { this.closed = true; }
  }
  const sdk = {
    SpeechRecognizer: Recognizer,
    SpeechConfig: { fromEndpoint: (endpoint, key) => {
      const config = { endpoint, key, properties: {}, setProperty(name, value) { this.properties[name] = value; }, close() { this.closed = true; } };
      configs.push(config); return config;
    } },
    AudioStreamFormat: { getWaveFormatPCM: (rate, bits, channels) => ({ rate, bits, channels }) },
    AudioInputStream: { createPushStream: format => {
      const stream = { format, packets: [], write(bytes) { this.packets.push(bytes); }, close() { this.closed = true; } };
      streams.push(stream); return stream;
    } },
    AudioConfig: { fromStreamInput: stream => ({ stream, close() { this.closed = true; } }) },
    PhraseListGrammar: { fromRecognizer: recognizer => ({ addPhrase: phrase => recognizer.phrases.push(phrase) }) },
    PropertyId: { Speech_SegmentationSilenceTimeoutMs: 'silence' },
    ResultReason: { RecognizedSpeech: 3, NoMatch: 0 },
    CancellationReason: { Error: 1 }
  };
  return { sdk, instances, configs, streams };
}
