import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../public/inference-worker.js', import.meta.url), 'utf8');

function encoder() {
    const windows = [];
    const context = vm.createContext({
        console: { log() {} }, postMessage() {}, Float32Array,
        onEncode(audio) {
            windows.push(audio.data);
            assert.ok(audio.data.length <= 64 * 1920, 'Encoder input exceeds the bounded attention window');
            const frames = Math.ceil(audio.data.length / 1920);
            const data = new Float32Array(frames * 2);
            for (let frame = 0; frame < frames; frame++) {
                data[frame * 2] = audio.data[frame * 1920];
            }
            return { latents: { data, dims: [1, frames, 2] } };
        },
    });
    context.self = context;
    vm.runInContext(source, context);
    vm.runInContext(`
        currentConditioningDim = 2;
        ort = { Tensor: class { constructor(type, data, dims) { this.data = data; this.dims = dims; } } };
        mimiEncoderSession = { outputNames: ['latents'], run: async ({ audio }) => onEncode(audio) };
    `, context);
    return { context, windows, encode: audio => context.encodeVoiceAudio(audio) };
}

test('30-second recordings use bounded overlapping windows and retain every feature frame', async () => {
    const { encode, windows } = encoder();
    const audio = Float32Array.from({ length: 30 * 24000 + 123 }, (_, i) => i / 1_000_000);
    const original = audio.slice();
    const result = await encode(audio);
    const frames = Math.ceil(audio.length / 1920);
    assert.deepEqual(Array.from(result.shape), [1, frames, 2]);
    assert.ok(windows.length > 1);
    for (let frame = 0; frame < frames; frame++) {
        assert.equal(result.data[frame * 2], audio[frame * 1920]);
    }
    assert.equal(windows[0].byteOffset, audio.byteOffset);
    assert.equal(windows.at(-1).at(-1), audio.at(-1));
    assert.deepEqual(audio, original);
});

test('short recordings keep their original single encoder pass', async () => {
    const { encode, windows } = encoder();
    const audio = new Float32Array(3 * 24000);
    await encode(audio);
    assert.equal(windows.length, 1);
    assert.equal(windows[0], audio);
});

test('native numeric failures identify the encoder stage', async () => {
    const { context, encode } = encoder();
    vm.runInContext('mimiEncoderSession.run = async () => { throw 202583232; };', context);
    await assert.rejects(encode(new Float32Array(24000)), /Voice sample encoding failed.*202583232/);
});
