import assert from 'node:assert/strict';
import test from 'node:test';
import { PocketTTSClient, VoiceStorage } from '../public/pocket-client.js';

test('generation is blocked until loading finishes, then sends the saved clone', async () => {
    const messages = [];
    const client = Object.create(PocketTTSClient.prototype);
    Object.assign(client, {
        el: { textInput: { value: 'Hello.' }, voiceSelect: { value: 'voice_saved' } },
        isWorkerReady: false,
        worker: { postMessage: message => messages.push(message) },
        setButtonState() {}, updateStatus() {},
    });
    await client.handleGenerate();
    assert.equal(messages.length, 0);
    assert.equal(client.pendingGeneration, undefined);

    const getVoice = VoiceStorage.getVoice;
    VoiceStorage.getVoice = async () => ({ id: 'voice_saved', name: 'My Voice', audioData: [0.1, 0.2] });
    try {
        client.isWorkerReady = true;
        await client.handleGenerate();
        assert.equal(messages.length, 1);
        assert.equal(messages[0].type, 'generate');
        assert.equal(messages[0].data.voice, 'voice_saved');
        assert.equal(messages[0].data.customVoice.voiceId, 'voice_saved');
        assert.ok(messages[0].data.customVoice.audio instanceof Float32Array);
    } finally {
        VoiceStorage.getVoice = getVoice;
    }
});

test('a prepared clone starts generation without rereading the saved recording', async () => {
    const messages = [];
    const client = Object.create(PocketTTSClient.prototype);
    Object.assign(client, {
        el: {}, preparedVoices: new Set(['voice_saved']), isWorkerReady: true,
        worker: { postMessage: message => messages.push(message) },
        setButtonState() {}, updateStatus() {},
    });
    const getVoice = VoiceStorage.getVoice;
    VoiceStorage.getVoice = async () => { throw new Error('Recording should already be prepared'); };
    try {
        await client.startActualGeneration('Hello.', 'voice_saved', 0.7);
        assert.equal(messages[0].data.voice, 'voice_saved');
        assert.equal(messages[0].data.customVoice, null);
    } finally {
        VoiceStorage.getVoice = getVoice;
    }
});

test('loading and startup failures lock voice actions until an explicit retry succeeds', async () => {
    const originalWorker = globalThis.Worker;
    const getVoice = VoiceStorage.getVoice;
    const workers = [];
    globalThis.Worker = class {
        messages = [];
        constructor() { workers.push(this); }
        postMessage(message) { this.messages.push(message); }
        terminate() { this.terminated = true; }
    };
    VoiceStorage.getVoice = async () => ({ id: 'voice_saved', audioData: [0.1] });
    const statuses = [];
    const client = Object.create(PocketTTSClient.prototype);
    Object.assign(client, {
        el: {
            textInput: { value: 'Hello.' }, voiceSelect: { value: 'voice_saved' },
            generateBtn: {}, recordBtn: {}, saveCloneBtn: {},
            retryEngineBtn: { classList: { toggle(name, hidden) { this.hidden = hidden; } } },
        },
        updateStatus(status) { statuses.push(status); },
    });
    try {
        client.initWorker();
        assert.equal(client.el.generateBtn.disabled, true);
        assert.equal(client.el.recordBtn.disabled, true);
        assert.equal(client.el.saveCloneBtn.disabled, true);
        await client.handleGenerate();
        workers[0].onerror({ message: 'Network error' });
        assert.equal(client.el.generateBtn.disabled, true);
        assert.equal(client.el.retryEngineBtn.classList.hidden, false);
        assert.match(statuses.at(-1), /Network error/);
        await client.handleGenerate();
        assert.equal(workers.length, 1);
        client.initWorker();
        assert.equal(workers.length, 2);
        assert.equal(workers[0].terminated, true);
        assert.deepEqual(workers[1].messages, [{ type: 'load' }]);
        await workers[1].onmessage({ data: { type: 'loaded' } });
        assert.equal(client.el.generateBtn.disabled, false);
        assert.equal(client.el.recordBtn.disabled, false);
        assert.equal(client.el.saveCloneBtn.disabled, false);
        assert.equal(workers[1].messages.length, 1);
        await client.handleGenerate();
        assert.equal(workers[1].messages.length, 2);
        assert.equal(workers[1].messages[1].data.customVoice.voiceId, 'voice_saved');
        await workers[1].onmessage({ data: { type: 'stream_ended' } });
        client.setEngineAvailability(false);
        assert.equal(client.el.generateBtn.disabled, true);
        await workers[1].onmessage({ data: { type: 'bundle_loaded', language: 'german', sampleRate: 24000 } });
        assert.equal(client.el.generateBtn.disabled, false);
    } finally {
        globalThis.Worker = originalWorker;
        VoiceStorage.getVoice = getVoice;
    }
});
