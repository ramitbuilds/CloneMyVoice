import assert from 'node:assert/strict';
import test from 'node:test';
import { PocketTTSClient, VoiceStorage } from '../public/pocket-client.js';

test('cloning preserves quiet captured speech and silence without additional filtering or gain', async () => {
    const originalWindow = globalThis.window;
    const originalOfflineContext = globalThis.OfflineAudioContext;
    const getAllVoices = VoiceStorage.getAllVoices;
    let contextsClosed = 0;
    const samples = new Float32Array(24000 * 3);
    for (let i = 12000; i < 18000; i++) samples[i] = 0.0002 * Math.sin(i / 10);
    for (let i = 24000; i < 48000; i++) samples[i] = 0.1 * Math.sin(i / 10) + 0.002;
    globalThis.window = { AudioContext: class {
        async decodeAudioData() { return { duration: 3 }; }
        async close() { contextsClosed++; }
    } };
    globalThis.OfflineAudioContext = class {
        constructor(channels, length, rate) {
            assert.deepEqual([channels, length, rate], [1, samples.length, 24000]);
        }
        createBufferSource() { return { connect() {}, start() {} }; }
        async startRendering() { return { getChannelData: () => samples }; }
    };
    VoiceStorage.getAllVoices = async () => [];
    const client = Object.create(PocketTTSClient.prototype);
    client.el = {};
    try {
        await client.handleRecordingFinished(new Blob(['recording']));
        assert.equal(client.pendingClonedAudio, samples);
        assert.equal(contextsClosed, 1);
        const wav = new DataView(await client.pendingPreviewBlob.arrayBuffer());
        assert.equal(wav.getUint32(40, true), samples.length * 2);
        assert.equal(wav.getInt16(44, true), 0);
        assert.equal(wav.getInt16(44 + 24000 * 2, true), Math.trunc(samples[24000] * 0x7FFF));
        assert.equal(wav.getInt16(wav.byteLength - 2, true), 0);
    } finally {
        if (client.clonedVoiceAudioUrl) URL.revokeObjectURL(client.clonedVoiceAudioUrl);
        globalThis.window = originalWindow;
        globalThis.OfflineAudioContext = originalOfflineContext;
        VoiceStorage.getAllVoices = getAllVoices;
    }
});

test('recorder setup failure closes an already granted microphone stream', async () => {
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const originalRecorder = globalThis.MediaRecorder;
    const originalAlert = globalThis.alert;
    let stopped = false;
    const stream = { getTracks: () => [{ stop() { stopped = true; } }] };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => stream } } });
    globalThis.MediaRecorder = class { constructor() { throw new Error('Unsupported recorder'); } };
    globalThis.alert = () => {};
    const client = Object.create(PocketTTSClient.prototype);
    Object.assign(client, { isWorkerReady: true, el: {} });
    try {
        await client.startRecording();
        assert.equal(stopped, true);
        assert.equal(client.mediaStream, null);
    } finally {
        if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
        else delete globalThis.navigator;
        globalThis.MediaRecorder = originalRecorder;
        globalThis.alert = originalAlert;
    }
});

test('microphone capture disables noise suppression, echo cancellation, and automatic gain', async () => {
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const originalRecorder = globalThis.MediaRecorder;
    let constraints;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
        mediaDevices: { getUserMedia: async options => { constraints = options; return {}; } },
    } });
    globalThis.MediaRecorder = class { start() {} };
    const client = Object.create(PocketTTSClient.prototype);
    Object.assign(client, { isWorkerReady: true, el: {}, startMicVisualizer() {} });
    try {
        await client.startRecording();
        assert.deepEqual(constraints.audio, {
            echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1,
        });
    } finally {
        clearInterval(client.recordingTimer);
        if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
        else delete globalThis.navigator;
        globalThis.MediaRecorder = originalRecorder;
    }
});
