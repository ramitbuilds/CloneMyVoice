import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../public/inference-worker.js', import.meta.url), 'utf8');

function worker() {
    const messages = [];
    const context = vm.createContext({
        console: { log() {}, error() {} },
        postMessage: (message) => messages.push(message),
        performance, setTimeout, Float32Array,
    });
    context.self = context;
    vm.runInContext(source, context);
    vm.runInContext(`
        isReady = true;
        splitIntoBestSentences = () => ({ chunks: ['Hello.'], framesAfterEos: 1 });
        encodeVoiceAudio = async () => {
            await new Promise(resolve => setTimeout(resolve, 15));
            return { data: new Float32Array(1024), shape: [1, 1, 1024] };
        };
        buildVoiceConditionedState = async () => {
            await new Promise(resolve => setTimeout(resolve, 15));
            return { prepared: true };
        };
        runGenerationPipeline = async (voice) => {
            if (!voiceConditioningCache.get(voice)?.prepared) throw new Error('Voice not prepared');
            postMessage({ type: 'audio_chunk', data: new Float32Array([0.1]) });
        };
    `, context);
    return { context, messages, send: (type, data) => context.self.onmessage({ data: { type, data } }) };
}

test('generation waits for an in-progress cloned voice load', async () => {
    const { send, messages } = worker();
    await Promise.all([
        send('load_custom_voice', { voiceId: 'voice_saved', audio: new Float32Array(24000) }),
        send('generate', { voice: 'voice_saved', text: 'Hello.' }),
    ]);
    assert.equal(messages.filter(m => m.type === 'error').length, 0);
    assert.equal(messages.filter(m => m.type === 'audio_chunk').length, 1);
});

test('generation loads a saved clone in the same request after a reload', async () => {
    const { send, messages } = worker();
    await send('generate', {
        voice: 'voice_saved', text: 'Hello.',
        customVoice: { voiceId: 'voice_saved', audio: new Float32Array(24000) },
    });
    assert.equal(messages.filter(m => m.type === 'error').length, 0);
    assert.equal(messages.filter(m => m.type === 'audio_chunk').length, 1);
});

test('a missing clone reports an error without claiming generation finished', async () => {
    const { send, messages } = worker();
    await send('generate', { voice: 'voice_missing', text: 'Hello.' });
    assert.equal(messages.filter(m => m.type === 'error').length, 1);
    assert.equal(messages.some(m => m.status === 'Finished'), false);
});

test('stop cancels generation while its cloned voice is being prepared', async () => {
    const { send, messages } = worker();
    const generation = send('generate', {
        voice: 'voice_saved', text: 'Hello.',
        customVoice: { voiceId: 'voice_saved', audio: new Float32Array(24000) },
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    await send('stop');
    await generation;
    assert.equal(messages.some(m => m.type === 'audio_chunk'), false);
    assert.equal(messages.some(m => m.type === 'generation_started'), false);
});

test('a failed clone load does not block subsequent built-in generation', async () => {
    const { context, send, messages } = worker();
    vm.runInContext(`
        predefinedVoiceRecords.alba = {};
        stateFromVoiceRecord = () => ({ prepared: true });
    `, context);
    await send('load_custom_voice', { voiceId: 'voice_missing' });
    await send('generate', { voice: 'alba', text: 'Hello.' });
    assert.equal(messages.filter(m => m.type === 'error').length, 1);
    assert.equal(messages.filter(m => m.type === 'audio_chunk').length, 1);
});
