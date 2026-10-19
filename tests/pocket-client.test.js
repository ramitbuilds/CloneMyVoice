import assert from 'node:assert/strict';
import test from 'node:test';
import { PocketTTSClient, VoiceStorage } from '../public/pocket-client.js';

test('completed speech autoplays once, after all chunks have been assembled', async () => {
    const events = [];
    const client = Object.create(PocketTTSClient.prototype);
    Object.assign(client, {
        el: {
            audioPlayback: { src: '', load() { events.push('load'); }, async play() { events.push('play'); } },
            downloadBtn: { disabled: true },
        },
        currentGenerationChunks: [], currentSampleRate: 24000,
        generationStartTime: performance.now(), generationRequestedAt: performance.now(),
        setButtonState() {}, updateStatus() {},
    });
    client.handleAudioChunk(new Float32Array([0.1, 0.2]));
    client.handleAudioChunk(new Float32Array([0.3]));
    assert.deepEqual(events, []);
    try {
        await client.handleStreamEnd();
        assert.deepEqual(events, ['load', 'play']);
        assert.equal(client.lastCompletedAudioBlob.size, 44 + 3 * 2);
        assert.equal(client.el.downloadBtn.disabled, false);
    } finally { URL.revokeObjectURL(client.lastCompletedAudioUrl); }
});

test('blocked autoplay preserves the download and offers manual playback', async () => {
    const statuses = [];
    let attempts = 0;
    const client = Object.create(PocketTTSClient.prototype);
    Object.assign(client, {
        el: {
            audioPlayback: { src: '', load() {}, async play() { attempts++; throw new Error('Autoplay blocked'); } },
            downloadBtn: { disabled: true },
        },
        currentGenerationChunks: [new Float32Array([0.1])], currentSampleRate: 24000,
        generationRequestedAt: performance.now(),
        setButtonState() {}, updateStatus(message) { statuses.push(message); },
    });
    try {
        await client.handleStreamEnd();
        assert.equal(attempts, 1);
        assert.equal(client.el.downloadBtn.disabled, false);
        assert.equal(client.isGenerating, false);
        assert.match(statuses.at(-1), /press play/i);
    } finally { URL.revokeObjectURL(client.lastCompletedAudioUrl); }
});

test('saved voice names reach only textContent, never the HTML template', async () => {
    const originalDocument = globalThis.document;
    const getAllVoices = VoiceStorage.getAllVoices;
    const voices = [
        { id: 'voice_1', name: '<b>Alex</b>' },
        { id: 'voice_2', name: '<img src=x onerror="alert(1)">' },
        { id: 'voice_" data-injected="yes', name: 'Alex & Jamie "take 2"' },
    ].map(voice => ({ ...voice, createdAt: Date.now() }));
    const cards = [];
    globalThis.document = {
        createElement() {
            const name = { textContent: '' };
            return {
                set innerHTML(html) {
                    for (const voice of voices) {
                        assert.equal(html.includes(voice.name), false);
                    }
                    assert.equal(html.includes('data-voice-id'), false);
                },
                querySelector(selector) {
                    return selector === '.saved-voice-name' ? name : { addEventListener() {} };
                },
            };
        },
    };
    VoiceStorage.getAllVoices = async () => voices;
    const client = Object.create(PocketTTSClient.prototype);
    client.el = { savedVoicesContainer: { appendChild: card => cards.push(card) } };
    try {
        await client.refreshSavedVoicesList();
        assert.deepEqual(cards.map(card => card.querySelector('.saved-voice-name').textContent), voices.map(v => v.name));
    } finally {
        globalThis.document = originalDocument;
        VoiceStorage.getAllVoices = getAllVoices;
    }
});

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

test('a saved-voice read failure restores Generate and allows a retry', async () => {
    const getVoice = VoiceStorage.getVoice;
    const messages = [];
    const statuses = [];
    const client = Object.create(PocketTTSClient.prototype);
    Object.assign(client, {
        el: { textInput: { value: 'Hello.' }, voiceSelect: { value: 'voice_saved' }, generateBtn: {} },
        isWorkerReady: true, isGenerating: false,
        worker: { postMessage: message => messages.push(message) },
        updateStatus(status) { statuses.push(status); },
    });
    VoiceStorage.getVoice = async () => { throw new Error('Storage read failed'); };
    try {
        await client.handleGenerate();
        assert.equal(client.el.generateBtn.disabled, false);
        assert.equal(client.isGenerating, false);
        assert.equal(messages.length, 0);
        assert.match(statuses.at(-1), /saved voice.*try again/i);
        VoiceStorage.getVoice = async () => ({ id: 'voice_saved', audioData: [0.1] });
        await client.handleGenerate();
        assert.equal(messages[0].type, 'generate');
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
