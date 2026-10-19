import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../public/inference-worker.js', import.meta.url), 'utf8');

function voiceFile(name = 'alba') {
    const bytes = Buffer.alloc(9 + 2 + name.length + 2 + 2 + 1 + 1 + 1 + 4 + 4 + 4);
    let offset = bytes.write('PTVB1');
    bytes.writeUInt32LE(1, offset); offset += 4;
    bytes.writeUInt16LE(name.length, offset); offset += 2;
    offset += bytes.write(name, offset);
    bytes.writeUInt16LE(1, offset); offset += 2;
    bytes.writeUInt16LE(1, offset); offset += 2;
    offset += bytes.write('x', offset);
    bytes[offset++] = 0; // float32
    bytes[offset++] = 1; // rank
    bytes.writeUInt32LE(1, offset); offset += 4;
    bytes.writeUInt32LE(4, offset); offset += 4;
    bytes.writeFloatLE(0.5, offset);
    return Uint8Array.from(bytes).buffer;
}

function worker(responses) {
    const deleted = [];
    const messages = [];
    let calls = 0;
    const context = vm.createContext({
        console: { log() {}, warn() {} }, TextDecoder, Float32Array,
        postMessage: message => messages.push(message),
        caches: { open: async () => ({ delete: async url => deleted.push(url) }) },
        nextResponse: async () => {
            const response = responses[calls++];
            if (response instanceof Error) throw response;
            return response;
        },
    });
    context.self = context;
    vm.runInContext(source, context);
    vm.runInContext(`bundleMetadata = { predefined_voices: ['alba'] };`, context);
    if (responses) vm.runInContext('fetchWithCache = nextResponse;', context);
    return { context, deleted, messages, calls: () => calls };
}

test('a damaged cached voice file is discarded and retried successfully', async () => {
    const state = worker([voiceFile().slice(0, -1), voiceFile()]);
    const records = await vm.runInContext('loadPredefinedVoices(DEFAULT_LANGUAGE)', state.context);
    assert.equal(records.alba.x.data[0], 0.5);
    assert.equal(state.calls(), 2);
    assert.equal(state.deleted.length, 1);
    assert.match(state.deleted[0], /english_2026-04\/voices\.bin$/);
    assert.ok(state.messages.some(message => /Retrying/.test(message.status)));
});

test('a transient voice-file network failure recovers automatically', async () => {
    const state = worker([new Error('Failed to fetch'), voiceFile()]);
    await vm.runInContext('loadPredefinedVoices(DEFAULT_LANGUAGE)', state.context);
    assert.equal(state.calls(), 2);
});

test('persistent download failure preserves an actionable startup error', async () => {
    const state = worker([new Error('Network offline'), new Error('Network offline')]);
    await assert.rejects(vm.runInContext('loadPredefinedVoices(DEFAULT_LANGUAGE)', state.context), /built-in voices.*Retry download.*Network offline/);
    assert.equal(state.calls(), 2);
    assert.equal(state.messages.some(message => message.type === 'bundle_loaded'), false);
});

test('a file missing the advertised Alba voice cannot be accepted', async () => {
    const state = worker([voiceFile('marius'), voiceFile('marius')]);
    await assert.rejects(vm.runInContext('loadPredefinedVoices(DEFAULT_LANGUAGE)', state.context), /missing required voices/);
});

test('an incomplete network download is rejected before it reaches the cache', async () => {
    const state = worker(null);
    let writes = 0;
    Object.assign(state.context, {
        AbortSignal,
        caches: { open: async () => ({ match: async () => null, put: async () => { writes++; } }) },
        fetch: async () => ({
            ok: true,
            headers: { get: name => name === 'content-length' ? '10' : null },
            body: { getReader: () => {
                let done = false;
                return { read: async () => {
                    if (done) return { done: true };
                    done = true;
                    return { done: false, value: new Uint8Array([1, 2, 3]) };
                } };
            } },
        }),
    });
    await assert.rejects(vm.runInContext('fetchWithCache("https://example.com/voices.bin", "voices.bin")', state.context), /Incomplete download/);
    assert.equal(writes, 0);
});
