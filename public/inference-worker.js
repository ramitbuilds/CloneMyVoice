// Kyutai Pocket TTS (100M) ONNX Web Worker with CacheStorage support
console.log("Pocket TTS Worker Starting...");
self.postMessage({ type: "status", status: "Loading speech engine...", state: "loading" });

let ort = null;

const CACHE_NAME = "pocket-tts-models-v1";
const DEFAULT_LANGUAGE = "english_2026-04";
const LANGUAGE_BUNDLES = ["english_2026-04", "german", "italian", "portuguese", "spanish"];
const MODEL_STEMS = {
    mimi_encoder: "mimi_encoder_int8.onnx",
    text_conditioner: "text_conditioner_int8.onnx",
    flow_lm_main: "flow_lm_main_int8.onnx",
    flow_lm_flow: "flow_lm_flow_int8.onnx",
    mimi_decoder: "mimi_decoder_int8.onnx",
};
const DEBUG_LOGS = false;
const CHUNK_GAP_SEC = 0.25;
const MAX_FRAMES = 500;
const LSD_STEPS = 1;
const RESET_FLOW_STATE_EACH_CHUNK = true;
const RESET_MIMI_STATE_EACH_CHUNK = true;

const MODEL_CDN_BASE = "https://huggingface.co/spaces/KevinAHM/pocket-tts-web/resolve/main/onnx";

let currentLanguage = DEFAULT_LANGUAGE;
let bundleMetadata = null;
let tokenizerProcessor = null;
let tokenizerModelB64 = null;
let bosBeforeVoice = null;

let mimiEncoderSession = null;
let textConditionerSession = null;
let flowLmMainSession = null;
let flowLmFlowSession = null;
let mimiDecoderSession = null;

let currentSampleRate = 24000;
let currentSamplesPerFrame = 1920;
let currentLatentDim = 32;
let currentConditioningDim = 1024;
let currentMaxTokenPerChunk = 50;

let predefinedVoiceRecords = {};
let customVoiceEmbedding = null;
const customVoicesEmbeddings = new Map();
let currentVoiceName = null;
let voiceConditioningCache = new Map();

let stTensors = [];
let isGenerating = false;
let isReady = false;
let pendingGenerationRequest = null;

function bundleUrl(language, filename) {
    return `${MODEL_CDN_BASE}/${language}/${filename}`;
}

function debugLog(...args) {
    if (DEBUG_LOGS) {
        console.log(...args);
    }
}

// Progressive Cached Fetch with CacheStorage
async function fetchWithCache(url, progressLabel = "") {
    let cache = null;
    try {
        if ("caches" in self) {
            cache = await caches.open(CACHE_NAME);
            const cachedResponse = await cache.match(url);
            if (cachedResponse) {
                const buffer = await cachedResponse.arrayBuffer();
                self.postMessage({
                    type: "download_progress",
                    file: progressLabel || url.split("/").pop(),
                    loaded: buffer.byteLength,
                    total: buffer.byteLength,
                    percent: 100,
                    fromCache: true,
                });
                return buffer;
            }
        }
    } catch (e) {
        console.warn("CacheStorage read warning:", e);
    }

    self.postMessage({
        type: "status",
        status: "Preparing audio engine...",
        state: "loading",
    });

    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
        throw new Error(`Failed to fetch ${url} (HTTP ${response.status})`);
    }

    const contentLength = Number(response.headers.get("content-length")) || 0;
    const fileName = progressLabel || url.split("/").pop();

    if (!response.body || contentLength === 0) {
        const buffer = await response.arrayBuffer();
        if (cache) {
            try {
                await cache.put(url, new Response(buffer.slice(0), {
                    headers: { "content-type": "application/octet-stream" },
                }));
            } catch (err) {
                console.warn("Cache put error:", err);
            }
        }
        return buffer;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let receivedBytes = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        receivedBytes += value.length;

        const percent = Math.min(100, Math.round((receivedBytes / contentLength) * 100));
        self.postMessage({
            type: "download_progress",
            file: fileName,
            loaded: receivedBytes,
            total: contentLength,
            percent,
            fromCache: false,
        });
    }

    const fullBuffer = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
        fullBuffer.set(chunk, offset);
        offset += chunk.length;
    }

    if (cache) {
        try {
            await cache.put(url, new Response(fullBuffer.buffer.slice(0), {
                headers: { "content-type": "application/octet-stream" },
            }));
        } catch (err) {
            console.warn("Cache put error:", err);
        }
    }

    return fullBuffer.buffer;
}

function makeFilledArray(shape, dtype, fill) {
    const size = shape.reduce((a, b) => a * b, 1);
    let data;

    if (dtype === "int64") {
        data = new BigInt64Array(size);
    } else if (dtype === "bool") {
        data = new Uint8Array(size);
    } else {
        data = new Float32Array(size);
        if (fill === "nan") {
            data.fill(NaN);
        } else if (fill === "ones") {
            data.fill(1);
        }
    }

    return data;
}

function createTensor(dtype, data, dims) {
    return new ort.Tensor(dtype, data, dims);
}

function initStateFromManifest(manifest) {
    const state = {};
    for (const entry of manifest) {
        state[entry.input_name] = createTensor(
            entry.dtype,
            makeFilledArray(entry.shape, entry.dtype, entry.fill),
            entry.shape
        );
    }
    return state;
}

function cloneState(state) {
    return { ...state };
}

function updateStateFromManifestOutputs(state, result, manifest) {
    for (const entry of manifest) {
        state[entry.input_name] = result[entry.output_name];
    }
}

function groupVoiceRecordByModule(record) {
    const grouped = {};
    for (const [key, value] of Object.entries(record)) {
        const slash = key.indexOf("/");
        if (slash === -1) continue;
        const moduleName = key.slice(0, slash);
        const tensorKey = key.slice(slash + 1);
        if (!grouped[moduleName]) {
            grouped[moduleName] = {};
        }
        grouped[moduleName][tensorKey] = value;
    }
    return grouped;
}

function adaptTypedArray(source, entry) {
    const targetShape = entry.shape;
    const targetSize = targetShape.reduce((a, b) => a * b, 1);
    const target = makeFilledArray(targetShape, entry.dtype, entry.fill);

    if (source.shape.length === targetShape.length) {
        const exactShape = source.shape.every((dim, idx) => dim === targetShape[idx]);
        if (exactShape) {
            if (entry.dtype === "int64") {
                return new BigInt64Array(source.data);
            }
            if (entry.dtype === "bool") {
                return new Uint8Array(source.data);
            }
            return new Float32Array(source.data);
        }
    }

    if (source.data.length === targetSize) {
        if (entry.dtype === "int64") {
            return new BigInt64Array(source.data);
        }
        if (entry.dtype === "bool") {
            return new Uint8Array(source.data);
        }
        return new Float32Array(source.data);
    }

    if (source.shape.length !== targetShape.length) {
        return target;
    }

    const strides = [];
    let stride = 1;
    for (let i = source.shape.length - 1; i >= 0; i--) {
        strides[i] = stride;
        stride *= source.shape[i];
    }

    const indices = new Array(source.shape.length).fill(0);
    const maxIndices = source.shape.map((dim, idx) => Math.min(dim, targetShape[idx]));

    function targetIndex(coords) {
        let idx = 0;
        let tStride = 1;
        for (let i = targetShape.length - 1; i >= 0; i--) {
            idx += coords[i] * tStride;
            tStride *= targetShape[i];
        }
        return idx;
    }

    let done = false;
    while (!done) {
        let sourceIdx = 0;
        for (let i = 0; i < indices.length; i++) {
            sourceIdx += indices[i] * strides[i];
        }
        target[targetIndex(indices)] = source.data[sourceIdx];

        for (let dim = indices.length - 1; dim >= 0; dim--) {
            indices[dim] += 1;
            if (indices[dim] < maxIndices[dim]) {
                break;
            }
            indices[dim] = 0;
            if (dim === 0) {
                done = true;
            }
        }
    }

    return target;
}

function deriveStep(moduleState) {
    if (moduleState.step) {
        return { data: BigInt64Array.from([BigInt(moduleState.step.data[0])]), shape: [1], dtype: "int64" };
    }
    if (moduleState.offset && !moduleState.end_offset) {
        return { data: BigInt64Array.from([BigInt(moduleState.offset.data[0])]), shape: [1], dtype: "int64" };
    }
    if (moduleState.current_end) {
        return { data: BigInt64Array.from([BigInt(moduleState.current_end.shape[0])]), shape: [1], dtype: "int64" };
    }
    return { data: BigInt64Array.from([0n]), shape: [1], dtype: "int64" };
}

function stateFromVoiceRecord(record) {
    const grouped = groupVoiceRecordByModule(record);
    const state = initStateFromManifest(bundleMetadata.flow_lm_state_manifest);

    for (const entry of bundleMetadata.flow_lm_state_manifest) {
        const moduleState = grouped[entry.module] || {};
        let source = moduleState[entry.key];
        if (!source && entry.key === "step") {
            source = deriveStep(moduleState);
        }
        if (!source) {
            continue;
        }

        const data = adaptTypedArray(source, entry);
        state[entry.input_name] = createTensor(entry.dtype, data, entry.shape);
    }

    return state;
}

function prepareVoiceEmbeddingData(voiceEmb) {
    let data = voiceEmb.data;
    let dims = voiceEmb.shape.slice();

    if (bundleMetadata.insert_bos_before_voice && bosBeforeVoice) {
        const bosData = bosBeforeVoice.data;
        const combined = new Float32Array(bosData.length + data.length);
        combined.set(bosData, 0);
        combined.set(data, bosData.length);
        data = combined;
        dims = [1, dims[1] + bosBeforeVoice.shape[1], dims[2]];
    }

    return createTensor("float32", data, dims);
}

async function buildVoiceConditionedState(voiceEmb) {
    const flowLmState = initStateFromManifest(bundleMetadata.flow_lm_state_manifest);
    const emptySeq = createTensor("float32", new Float32Array(0), [1, 0, currentLatentDim]);
    const voiceTensor = prepareVoiceEmbeddingData(voiceEmb);

    const result = await flowLmMainSession.run({
        sequence: emptySeq,
        text_embeddings: voiceTensor,
        ...flowLmState,
    });

    updateStateFromManifestOutputs(flowLmState, result, bundleMetadata.flow_lm_state_manifest);
    return flowLmState;
}

async function ensurePredefinedVoiceCached(voiceName, options = {}) {
    const { force = false, statusText = "Preparing voice..." } = options;
    if (!predefinedVoiceRecords[voiceName]) {
        throw new Error(`Unknown built-in voice: ${voiceName}`);
    }

    if (!force && voiceConditioningCache.has(voiceName)) {
        return voiceConditioningCache.get(voiceName);
    }

    postMessage({ type: "status", status: statusText, state: "loading" });
    const conditioned = stateFromVoiceRecord(predefinedVoiceRecords[voiceName]);
    voiceConditioningCache.set(voiceName, conditioned);
    return conditioned;
}

async function ensureCustomVoiceCached(options = {}) {
    const { voiceId = "custom", embedding = null, force = false, statusText = "Preparing custom cloned voice..." } = options;
    if (embedding) {
        customVoicesEmbeddings.set(voiceId, embedding);
    }
    const voiceEmb = customVoicesEmbeddings.get(voiceId) || customVoiceEmbedding;
    if (!voiceEmb) {
        throw new Error(`No custom voice loaded for voice ID: ${voiceId}.`);
    }

    if (!force && voiceConditioningCache.has(voiceId)) {
        return voiceConditioningCache.get(voiceId);
    }

    postMessage({ type: "status", status: statusText, state: "loading" });
    const conditioned = await buildVoiceConditionedState(voiceEmb);
    voiceConditioningCache.set(voiceId, conditioned);
    return conditioned;
}

function parseNpyFloat32(buffer) {
    const view = new DataView(buffer);
    const magic = new Uint8Array(buffer, 0, 6);
    const expected = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59];
    for (let i = 0; i < expected.length; i++) {
        if (magic[i] !== expected[i]) {
            throw new Error("Invalid NPY file header");
        }
    }

    const major = view.getUint8(6);
    const headerLen = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
    const headerOffset = major === 1 ? 10 : 12;
    const headerText = new TextDecoder().decode(new Uint8Array(buffer, headerOffset, headerLen));
    const shapeMatch = headerText.match(/\(\s*([0-9,\s]+)\)/);
    if (!shapeMatch) {
        throw new Error("Could not parse NPY shape");
    }
    const shape = shapeMatch[1]
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => Number.parseInt(part, 10));
    const dataOffset = headerOffset + headerLen;
    const data = new Float32Array(buffer, dataOffset);
    return { data: new Float32Array(data), shape };
}

function parseVoiceStatesBin(buffer) {
    const view = new DataView(buffer);
    let offset = 0;
    const magic = new TextDecoder().decode(new Uint8Array(buffer, offset, 5));
    offset += 5;
    if (magic !== "PTVB1") {
        throw new Error("Invalid voices.bin header: expected PTVB1");
    }

    const voices = {};
    const voiceCount = view.getUint32(offset, true);
    offset += 4;

    for (let voiceIndex = 0; voiceIndex < voiceCount; voiceIndex++) {
        const nameLen = view.getUint16(offset, true);
        offset += 2;
        const name = new TextDecoder().decode(new Uint8Array(buffer, offset, nameLen));
        offset += nameLen;

        const tensorCount = view.getUint16(offset, true);
        offset += 2;
        const tensors = {};

        for (let tensorIndex = 0; tensorIndex < tensorCount; tensorIndex++) {
            const keyLen = view.getUint16(offset, true);
            offset += 2;
            const key = new TextDecoder().decode(new Uint8Array(buffer, offset, keyLen));
            offset += keyLen;

            const dtypeCode = view.getUint8(offset);
            offset += 1;
            const rank = view.getUint8(offset);
            offset += 1;

            const shape = [];
            for (let dimIndex = 0; dimIndex < rank; dimIndex++) {
                shape.push(view.getUint32(offset, true));
                offset += 4;
            }

            const byteLength = view.getUint32(offset, true);
            offset += 4;

            let data;
            if (dtypeCode === 0) {
                data = new Float32Array(buffer.slice(offset, offset + byteLength));
            } else if (dtypeCode === 1) {
                data = new BigInt64Array(buffer.slice(offset, offset + byteLength));
            } else if (dtypeCode === 2) {
                data = new Uint8Array(buffer.slice(offset, offset + byteLength));
            } else {
                throw new Error(`Unsupported voices.bin dtype code: ${dtypeCode}`);
            }
            offset += byteLength;

            tensors[key] = {
                data,
                shape,
                dtype: dtypeCode === 0 ? "float32" : dtypeCode === 1 ? "int64" : "bool",
            };
        }

        voices[name] = tensors;
    }

    return voices;
}

async function encodeVoiceAudio(audioData) {
    if (!audioData?.length) {
        throw new Error("The voice recording is empty. Please record a voice sample first.");
    }

    // Encoder attention grows quadratically. Overlap provides context without exceeding WASM memory.
    const coreFrames = 32;
    const contextFrames = 16;
    const maxWindowFrames = coreFrames + 2 * contextFrames;
    const totalFrames = Math.ceil(audioData.length / currentSamplesPerFrame);
    if (totalFrames <= maxWindowFrames) {
        return encodeVoiceAudioWindow(audioData);
    }

    const data = new Float32Array(totalFrames * currentConditioningDim);
    for (let frame = 0; frame < totalFrames; frame += coreFrames) {
        const startFrame = Math.max(0, frame - contextFrames);
        const endFrame = Math.min(totalFrames, frame + coreFrames + contextFrames);
        const audio = audioData.subarray(
            startFrame * currentSamplesPerFrame,
            Math.min(audioData.length, endFrame * currentSamplesPerFrame),
        );
        const embedding = await encodeVoiceAudioWindow(audio);
        const offset = (frame - startFrame) * currentConditioningDim;
        const count = Math.min(coreFrames, totalFrames - frame) * currentConditioningDim;
        if (embedding.shape[2] !== currentConditioningDim || offset + count > embedding.data.length) {
            throw new Error("The voice encoder returned an unexpected feature shape.");
        }
        data.set(embedding.data.subarray(offset, offset + count), frame * currentConditioningDim);
    }
    return { data, shape: [1, totalFrames, currentConditioningDim] };
}

async function encodeVoiceAudioWindow(audioData) {
    const input = createTensor("float32", audioData, [1, 1, audioData.length]);
    let outputs;
    try {
        outputs = await mimiEncoderSession.run({ audio: input });
    } catch (err) {
        throw new Error(`Voice sample encoding failed (engine error: ${String(err)}). Please reload the page and try again.`);
    }
    const embeddings = outputs[mimiEncoderSession.outputNames[0]];

    let dims = embeddings.dims.slice();
    let data = new Float32Array(embeddings.data);
    while (dims.length > 3) {
        if (dims[0] !== 1) break;
        dims = dims.slice(1);
    }
    if (dims.length < 3) {
        dims = [1, dims[0], dims[1]];
    }

    return { data, shape: dims };
}

function prepareTextPrompt(text) {
    let prompt = text.trim();
    if (!prompt) {
        return { text: "", framesAfterEos: 1 };
    }

    prompt = prompt.replace(/\r/g, " ").replace(/\n/g, " ").replace(/\s+/g, " ");
    if (bundleMetadata && bundleMetadata.remove_semicolons) {
        prompt = prompt.replace(/;/g, ",");
    }

    const wordCount = prompt.split(/\s+/).filter(Boolean).length;
    let framesAfterEos = wordCount <= 4 ? 3 : 1;
    if (bundleMetadata && bundleMetadata.model_recommended_frames_after_eos != null) {
        framesAfterEos = Number(bundleMetadata.model_recommended_frames_after_eos);
    }

    if (prompt && !/[A-ZÀ-Þ]/.test(prompt[0])) {
        prompt = prompt[0].toUpperCase() + prompt.slice(1);
    }
    if (prompt && /[0-9A-Za-zÀ-ÿ]/.test(prompt[prompt.length - 1])) {
        prompt += ".";
    }
    if (bundleMetadata && bundleMetadata.pad_with_spaces_for_short_inputs && wordCount < 5) {
        prompt = "        " + prompt;
    }

    return { text: prompt, framesAfterEos };
}

const SENTENCE_SPLIT_RE = /[^.!?]+[.!?]+|[^.!?]+$/g;

function splitTextIntoSentences(text) {
    const matches = text.match(SENTENCE_SPLIT_RE);
    if (!matches) return [];
    return matches.map((sentence) => sentence.trim()).filter(Boolean);
}

function splitTokenIdsIntoChunks(tokenIds, maxTokens) {
    const chunks = [];
    for (let i = 0; i < tokenIds.length; i += maxTokens) {
        const chunkText = tokenizerProcessor.decodeIds(tokenIds.slice(i, i + maxTokens)).trim();
        if (chunkText) {
            chunks.push(chunkText);
        }
    }
    return chunks;
}

function splitIntoBestSentences(text) {
    const prepared = prepareTextPrompt(text);
    if (!prepared.text) {
        return { chunks: [], framesAfterEos: prepared.framesAfterEos };
    }

    const sentences = splitTextIntoSentences(prepared.text);
    if (!sentences.length) {
        return { chunks: [prepared.text], framesAfterEos: prepared.framesAfterEos };
    }

    const chunks = [];
    let currentChunk = "";

    for (const sentenceText of sentences) {
        const sentenceTokenIds = tokenizerProcessor.encodeIds(sentenceText);
        const sentenceTokens = sentenceTokenIds.length;

        if (sentenceTokens > currentMaxTokenPerChunk) {
            if (currentChunk) {
                chunks.push(currentChunk.trim());
                currentChunk = "";
            }
            const splitChunks = splitTokenIdsIntoChunks(sentenceTokenIds, currentMaxTokenPerChunk);
            for (const splitChunk of splitChunks) {
                if (splitChunk) {
                    chunks.push(splitChunk.trim());
                }
            }
            continue;
        }

        if (!currentChunk) {
            currentChunk = sentenceText;
            continue;
        }

        const combined = `${currentChunk} ${sentenceText}`;
        const combinedTokens = tokenizerProcessor.encodeIds(combined).length;
        if (combinedTokens > currentMaxTokenPerChunk) {
            chunks.push(currentChunk.trim());
            currentChunk = sentenceText;
        } else {
            currentChunk = combined;
        }
    }

    if (currentChunk) {
        chunks.push(currentChunk.trim());
    }

    return { chunks, framesAfterEos: prepared.framesAfterEos };
}

function precomputeFlowBuffers() {
    stTensors = [];
    const dt = 1.0 / LSD_STEPS;
    for (let step = 0; step < LSD_STEPS; step++) {
        const s = step / LSD_STEPS;
        const t = s + dt;
        stTensors.push({
            s: createTensor("float32", new Float32Array([s]), [1, 1]),
            t: createTensor("float32", new Float32Array([t]), [1, 1]),
        });
    }
}

async function loadOrt() {
    if (ort) {
        return;
    }

    postMessage({ type: "status", status: "Loading ONNX Runtime Web...", state: "loading" });
    const version = "1.20.0";
    const cdnBase = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/`;
    const ortModule = await import(`https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/ort.min.mjs`);
    ort = ortModule.default || ortModule;
    ort.env.wasm.wasmPaths = cdnBase;
    ort.env.wasm.simd = true;
    ort.env.wasm.numThreads = self.crossOriginIsolated
        ? Math.min(navigator.hardwareConcurrency || 4, 8)
        : 1;
    precomputeFlowBuffers();
}

async function releaseSession(session) {
    if (!session) {
        return;
    }
    if (typeof session.release === "function") {
        await session.release();
    }
}

async function loadBundle(language, { initialLoad = false } = {}) {
    if (!LANGUAGE_BUNDLES.includes(language)) {
        throw new Error(`Unsupported language bundle: ${language}`);
    }

    await loadOrt();

    postMessage({ type: "status", status: "Preparing voice engine...", state: "loading" });
    currentLanguage = language;

    // 1. Fetch metadata
    const metadataBuffer = await fetchWithCache(bundleUrl(language, "bundle.json"), "bundle.json");
    bundleMetadata = JSON.parse(new TextDecoder().decode(metadataBuffer));

    currentSampleRate = Number(bundleMetadata.sample_rate);
    currentSamplesPerFrame = Number(bundleMetadata.samples_per_frame);
    currentLatentDim = Number(bundleMetadata.latent_dim);
    currentConditioningDim = Number(bundleMetadata.conditioning_dim);
    currentMaxTokenPerChunk = Number(bundleMetadata.max_token_per_chunk || 50);
    isReady = false;

    await Promise.all([
        releaseSession(mimiEncoderSession),
        releaseSession(textConditionerSession),
        releaseSession(flowLmMainSession),
        releaseSession(flowLmFlowSession),
        releaseSession(mimiDecoderSession),
    ]);

    const sessionOptions = {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
    };

    // 2. Fetch model binaries (cached into browser Cache API)
    postMessage({ type: "status", status: "Loading ONNX model graphs...", state: "loading" });
    const [encoderBuf, textCondBuf, flowMainBuf, flowFlowBuf, decoderBuf] = await Promise.all([
        fetchWithCache(bundleUrl(language, MODEL_STEMS.mimi_encoder), MODEL_STEMS.mimi_encoder),
        fetchWithCache(bundleUrl(language, MODEL_STEMS.text_conditioner), MODEL_STEMS.text_conditioner),
        fetchWithCache(bundleUrl(language, MODEL_STEMS.flow_lm_main), MODEL_STEMS.flow_lm_main),
        fetchWithCache(bundleUrl(language, MODEL_STEMS.flow_lm_flow), MODEL_STEMS.flow_lm_flow),
        fetchWithCache(bundleUrl(language, MODEL_STEMS.mimi_decoder), MODEL_STEMS.mimi_decoder),
    ]);

    postMessage({ type: "status", status: "Initializing ONNX sessions...", state: "loading" });
    const [encoderRes, textCondRes, flowMainRes, flowFlowRes, decoderRes] = await Promise.all([
        ort.InferenceSession.create(encoderBuf, sessionOptions),
        ort.InferenceSession.create(textCondBuf, sessionOptions),
        ort.InferenceSession.create(flowMainBuf, sessionOptions),
        ort.InferenceSession.create(flowFlowBuf, sessionOptions),
        ort.InferenceSession.create(decoderBuf, sessionOptions),
    ]);

    mimiEncoderSession = encoderRes;
    textConditionerSession = textCondRes;
    flowLmMainSession = flowMainRes;
    flowLmFlowSession = flowFlowRes;
    mimiDecoderSession = decoderRes;

    // 3. Tokenizer
    postMessage({ type: "status", status: "Loading Tokenizer...", state: "loading" });
    const tokenizerBuffer = await fetchWithCache(bundleUrl(language, bundleMetadata.tokenizer_file), "tokenizer.model");
    tokenizerModelB64 = btoa(String.fromCharCode(...new Uint8Array(tokenizerBuffer)));
    const spModule = await import("./sentencepiece.js?v=4");
    tokenizerProcessor = new spModule.SentencePieceProcessor();
    await tokenizerProcessor.loadFromB64StringModel(tokenizerModelB64);

    // 4. BOS before voice
    bosBeforeVoice = null;
    if (bundleMetadata.bos_before_voice_file) {
        try {
            const bosBuffer = await fetchWithCache(bundleUrl(language, bundleMetadata.bos_before_voice_file), "bos_before_voice.npy");
            bosBeforeVoice = parseNpyFloat32(bosBuffer);
        } catch (e) {
            console.warn("Could not load bos_before_voice:", e);
        }
    }

    // 5. Predefined voices
    predefinedVoiceRecords = {};
    try {
        const voicesBuffer = await fetchWithCache(bundleUrl(language, "voices.bin"), "voices.bin");
        predefinedVoiceRecords = parseVoiceStatesBin(voicesBuffer);
    } catch (e) {
        console.warn("Could not load voices.bin:", e);
    }

    voiceConditioningCache = new Map();
    let defaultVoice = bundleMetadata.predefined_voices?.includes("alba") ? "alba" : null;
    if (!defaultVoice) {
        defaultVoice = Object.keys(predefinedVoiceRecords)[0] || null;
    }
    currentVoiceName = defaultVoice;

    if (defaultVoice) {
        await ensurePredefinedVoiceCached(defaultVoice, {
            force: true,
            statusText: `Preparing voice (${defaultVoice})...`,
        });
    }

    if (customVoiceEmbedding) {
        voiceConditioningCache.delete("custom");
    }

    isReady = true;

    postMessage({
        type: "voices_loaded",
        voices: bundleMetadata.predefined_voices || Object.keys(predefinedVoiceRecords),
        defaultVoice,
        language,
    });
    postMessage({
        type: "bundle_loaded",
        language,
        sampleRate: currentSampleRate,
        initialLoad,
    });
    postMessage({ type: "status", status: "Ready", state: "idle" });
    postMessage({ type: "model_status", status: "ready", text: "Voice engine ready" });
    if (initialLoad) {
        postMessage({ type: "loaded" });
    }

    if (pendingGenerationRequest) {
        const req = pendingGenerationRequest;
        pendingGenerationRequest = null;
        await startGeneration(req.text, req.voice, req.temperature);
    }
}

// ONNX sessions cannot run concurrently; serialize preparation and generation.
let messageQueue = Promise.resolve();
let stopVersion = 0;
self.onmessage = (e) => {
    if (e.data.type === "stop") {
        stopVersion++;
        return handleMessage(e);
    }
    const version = stopVersion;
    messageQueue = messageQueue.then(() => {
        if (e.data.type === "generate" && version !== stopVersion) return;
        return handleMessage(e, version);
    });
    return messageQueue;
};

async function loadCustomVoice({ voiceId, voiceName, embedding, audio }) {
    let emb = customVoicesEmbeddings.get(voiceId) || embedding;
    if (!emb && audio) {
        emb = await encodeVoiceAudio(audio);
    }
    if (!emb) {
        throw new Error(`No saved audio or embedding for voice ID: ${voiceId}. Please record the voice again.`);
    }
    if (!(emb.data instanceof Float32Array)) {
        emb.data = new Float32Array(emb.data);
    }
    await ensureCustomVoiceCached({
        voiceId,
        embedding: emb,
        statusText: `Preparing voice (${voiceName || voiceId})...`,
    });
    currentVoiceName = voiceId;
}

async function handleMessage(e, version = stopVersion) {
    const { type, data } = e.data;

    try {
        if (type === "load") {
            await loadBundle(DEFAULT_LANGUAGE, { initialLoad: true });
            return;
        }

        if (type === "generate") {
            if (!isReady) {
                postMessage({ type: "status", status: "Preparing voice engine...", state: "loading" });
                pendingGenerationRequest = {
                    text: data.text,
                    voice: data.voice || currentVoiceName || "alba",
                    temperature: data.temperature || 0.7,
                };
                return;
            }
            if (isGenerating) {
                return;
            }
            if (data.customVoice) {
                await loadCustomVoice(data.customVoice);
                postMessage({ type: "voice_set", voiceName: currentVoiceName });
            }
            if (version !== stopVersion) return;
            await startGeneration(data.text, data.voice || currentVoiceName, data.temperature || 0.7);
            return;
        }

        if (type === "set_language") {
            if (isGenerating) {
                postMessage({ type: "error", error: "Cannot switch language while generation is in progress." });
                return;
            }
            await loadBundle(data.language, { initialLoad: false });
            return;
        }

        if (type === "stop") {
            isGenerating = false;
            pendingGenerationRequest = null;
            postMessage({ type: "status", status: "Stopped", state: "idle" });
            return;
        }

        if (type === "clear_cache") {
            if ("caches" in self) {
                await caches.delete(CACHE_NAME);
                postMessage({ type: "cache_cleared", message: "Model cache cleared successfully." });
            }
            return;
        }

        if (!isReady) {
            postMessage({ type: "error", error: "Voice engine is preparing. Please try again in a moment." });
            return;
        }

        if (type === "encode_voice") {
            if (isGenerating) {
                postMessage({ type: "error", error: "Cannot clone voice while speech generation is active." });
                return;
            }
            postMessage({ type: "status", status: "Analyzing voice sample...", state: "loading" });
            const embedding = await encodeVoiceAudio(data.audio);
            const voiceId = data.voiceId || "custom";
            customVoicesEmbeddings.set(voiceId, embedding);
            customVoiceEmbedding = embedding;
            currentVoiceName = voiceId;
            await ensureCustomVoiceCached({
                voiceId,
                embedding,
                force: true,
                statusText: "Finalizing cloned voice..."
            });
            postMessage({
                type: "voice_encoded",
                voiceId: voiceId,
                voiceName: data.voiceName || "My Cloned Voice",
                embedding: {
                    data: embedding.data,
                    shape: embedding.shape,
                }
            });
            postMessage({ type: "status", status: "Voice cloned and ready", state: "idle" });
            return;
        }

        if (type === "load_custom_voice") {
            await loadCustomVoice(data);
            postMessage({ type: "voice_set", voiceName: currentVoiceName });
            postMessage({ type: "status", status: "Ready", state: "idle" });
            return;
        }

        if (type === "set_voice") {
            if (isGenerating) {
                postMessage({ type: "error", error: "Cannot switch voice during generation." });
                return;
            }
            const vName = data.voiceName;
            if (vName === "custom" || vName.startsWith("voice_") || customVoicesEmbeddings.has(vName)) {
                await ensureCustomVoiceCached({ voiceId: vName, statusText: "Preparing custom voice..." });
                currentVoiceName = vName;
            } else {
                await ensurePredefinedVoiceCached(vName, {
                    statusText: `Preparing voice (${vName})...`,
                });
                currentVoiceName = vName;
            }
            postMessage({ type: "voice_set", voiceName: currentVoiceName });
            postMessage({ type: "status", status: "Ready", state: "idle" });
            return;
        }
    } catch (err) {
        console.error("Worker error:", err);
        postMessage({ type: "error", error: err.toString() });
    }
}

async function startGeneration(text, voiceName, temperature = 0.7) {
    isGenerating = true;
    postMessage({ type: "status", status: "Generating speech...", state: "running" });
    postMessage({ type: "generation_started", data: { time: performance.now() } });

    try {
        const { chunks, framesAfterEos } = splitIntoBestSentences(text);
        if (!chunks.length) {
            throw new Error("No text provided for speech synthesis.");
        }

        if (voiceName === "custom" || voiceName.startsWith("voice_") || customVoicesEmbeddings.has(voiceName)) {
            await ensureCustomVoiceCached({ voiceId: voiceName, statusText: "Preparing custom voice..." });
        } else {
            await ensurePredefinedVoiceCached(voiceName, {
                statusText: `Preparing voice (${voiceName})...`,
            });
        }
        currentVoiceName = voiceName;

        await runGenerationPipeline(voiceName, chunks, framesAfterEos, temperature);
    } catch (err) {
        console.error("Generation error:", err);
        isGenerating = false;
        postMessage({ type: "error", error: err.toString() });
    } finally {
        if (isGenerating) {
            postMessage({ type: "stream_ended" });
            postMessage({ type: "status", status: "Finished", state: "idle" });
        }
        isGenerating = false;
    }
}

async function runGenerationPipeline(voiceName, chunks, framesAfterEos, temperature = 0.7) {
    let mimiState = initStateFromManifest(bundleMetadata.mimi_state_manifest);
    const emptySeq = createTensor("float32", new Float32Array(0), [1, 0, currentLatentDim]);
    const emptyTextEmb = createTensor("float32", new Float32Array(0), [1, 0, currentConditioningDim]);
    const baseFlowState = voiceConditioningCache.get(voiceName);
    if (!baseFlowState) {
        throw new Error(`Voice conditioning cache missing for '${voiceName}'.`);
    }
    let flowLmState = cloneState(baseFlowState);

    const firstChunkFrames = 3;
    const normalChunkFrames = 8;
    const allGeneratedLatents = [];
    let isFirstAudioChunk = true;
    let totalFlowLmTime = 0;
    let totalDecodeTime = 0;
    const generationStart = performance.now();

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
        if (!isGenerating) break;

        if (RESET_FLOW_STATE_EACH_CHUNK && chunkIdx > 0) {
            flowLmState = cloneState(baseFlowState);
        }
        if (RESET_MIMI_STATE_EACH_CHUNK && chunkIdx > 0) {
            mimiState = initStateFromManifest(bundleMetadata.mimi_state_manifest);
        }

        const chunkText = chunks[chunkIdx];
        let isFirstAudioChunkOfTextChunk = true;
        const tokenIds = tokenizerProcessor.encodeIds(chunkText);
        const textInput = createTensor(
            "int64",
            BigInt64Array.from(tokenIds.map((token) => BigInt(token))),
            [1, tokenIds.length]
        );

        let textEmb = (await textConditionerSession.run({ token_ids: textInput }))[textConditionerSession.outputNames[0]];
        if (textEmb.dims.length === 2) {
            textEmb = createTensor("float32", new Float32Array(textEmb.data), [1, textEmb.dims[0], textEmb.dims[1]]);
        }

        const flowLmFeeds = {
            sequence: emptySeq,
            text_embeddings: textEmb,
            ...flowLmState,
        };
        const condResult = await flowLmMainSession.run(flowLmFeeds);
        updateStateFromManifestOutputs(flowLmState, condResult, bundleMetadata.flow_lm_state_manifest);
        for (const entry of bundleMetadata.flow_lm_state_manifest) {
            flowLmFeeds[entry.input_name] = condResult[entry.output_name];
        }
        flowLmFeeds.text_embeddings = emptyTextEmb;

        const chunkLatents = [];
        let chunkDecodedFrames = 0;
        let currentLatent = createTensor("float32", new Float32Array(currentLatentDim).fill(NaN), [1, 1, currentLatentDim]);
        let eosStep = null;
        let chunkEnded = false;
        let chunkGenTimeMs = 0;

        for (let step = 0; step < MAX_FRAMES; step++) {
            if (!isGenerating) break;
            if (step > 0 && step % 12 === 0) {
                await new Promise((resolve) => setTimeout(resolve, 0));
            }

            const stepStart = performance.now();
            flowLmFeeds.sequence = currentLatent;
            const arResult = await flowLmMainSession.run(flowLmFeeds);
            const stepElapsed = performance.now() - stepStart;
            chunkGenTimeMs += stepElapsed;
            totalFlowLmTime += stepElapsed;

            for (const entry of bundleMetadata.flow_lm_state_manifest) {
                const val = arResult[entry.output_name];
                flowLmState[entry.input_name] = val;
                flowLmFeeds[entry.input_name] = val;
            }

            const conditioning = arResult.conditioning;
            const eosLogit = arResult.eos_logit.data[0];
            const isEos = eosLogit > -4.0;
            if (isEos && eosStep == null) {
                eosStep = step;
            }
            const shouldStop = eosStep != null && step >= eosStep + framesAfterEos;

            const std = Math.sqrt(Math.max(0.01, temperature));
            const latentData = new Float32Array(currentLatentDim);
            for (let i = 0; i < currentLatentDim; i += 2) {
                let u = Math.random();
                while (u === 0) u = Math.random();
                const v = Math.random() * 2.0 * Math.PI;
                const r = Math.sqrt(-2.0 * Math.log(u)) * std;
                latentData[i] = r * Math.cos(v);
                if (i + 1 < currentLatentDim) {
                    latentData[i + 1] = r * Math.sin(v);
                }
            }

            const dt = 1.0 / LSD_STEPS;
            for (let lsdIndex = 0; lsdIndex < LSD_STEPS; lsdIndex++) {
                const flowResult = await flowLmFlowSession.run({
                    c: conditioning,
                    s: stTensors[lsdIndex].s,
                    t: stTensors[lsdIndex].t,
                    x: createTensor("float32", latentData, [1, currentLatentDim]),
                });
                const flowDir = flowResult.flow_dir.data;
                for (let i = 0; i < currentLatentDim; i++) {
                    latentData[i] += flowDir[i] * dt;
                }
            }

            chunkLatents.push(new Float32Array(latentData));
            allGeneratedLatents.push(new Float32Array(latentData));
            currentLatent = createTensor("float32", latentData, [1, 1, currentLatentDim]);

            const pending = chunkLatents.length - chunkDecodedFrames;
            let decodeSize = 0;
            if (shouldStop) {
                decodeSize = pending;
            } else if (isFirstAudioChunk && pending >= firstChunkFrames) {
                decodeSize = firstChunkFrames;
            } else if (pending >= normalChunkFrames) {
                decodeSize = normalChunkFrames;
            }

            if (decodeSize > 0) {
                const decodeLatents = new Float32Array(decodeSize * currentLatentDim);
                for (let frame = 0; frame < decodeSize; frame++) {
                    decodeLatents.set(chunkLatents[chunkDecodedFrames + frame], frame * currentLatentDim);
                }

                const decoderStart = performance.now();
                const decodeResult = await mimiDecoderSession.run({
                    latent: createTensor("float32", decodeLatents, [1, decodeSize, currentLatentDim]),
                    ...mimiState,
                });
                const decoderElapsed = performance.now() - decoderStart;
                chunkGenTimeMs += decoderElapsed;
                totalDecodeTime += decoderElapsed;

                for (const entry of bundleMetadata.mimi_state_manifest) {
                    mimiState[entry.input_name] = decodeResult[entry.output_name];
                }

                chunkDecodedFrames += decodeSize;
                const audioFloat32 = new Float32Array(decodeResult[mimiDecoderSession.outputNames[0]].data);
                const isLastChunk = shouldStop && chunkIdx === chunks.length - 1;

                postMessage({
                    type: "audio_chunk",
                    data: audioFloat32,
                    metrics: {
                        bbTime: 0,
                        decTime: 0,
                        chunkDuration: audioFloat32.length / currentSampleRate,
                        genTimeSec: chunkGenTimeMs / 1000,
                        isFirst: isFirstAudioChunk,
                        isLast: isLastChunk,
                        chunkStart: isFirstAudioChunkOfTextChunk,
                    },
                }, [audioFloat32.buffer]);

                isFirstAudioChunk = false;
                isFirstAudioChunkOfTextChunk = false;
                chunkGenTimeMs = 0;
            }

            if (shouldStop) {
                chunkEnded = true;
                break;
            }
        }

        if (chunkEnded && isGenerating && chunkIdx < chunks.length - 1) {
            const gapSamples = Math.max(1, Math.floor(CHUNK_GAP_SEC * currentSampleRate));
            const silence = new Float32Array(gapSamples);
            postMessage({
                type: "audio_chunk",
                data: silence,
                metrics: {
                    bbTime: 0,
                    decTime: 0,
                    chunkDuration: gapSamples / currentSampleRate,
                    isFirst: false,
                    isLast: false,
                    isSilence: true,
                },
            }, [silence.buffer]);
        }
    }

    const totalTime = (performance.now() - generationStart) / 1000;
    const audioSeconds = allGeneratedLatents.length * currentSamplesPerFrame / currentSampleRate;
    const genTime = (totalFlowLmTime + totalDecodeTime) / 1000;
    const rtfx = genTime > 0 ? audioSeconds / genTime : 0;

    debugLog(`Generation complete for ${voiceName} in ${totalTime.toFixed(2)}s (RTFx ${rtfx.toFixed(2)}x)`);
    postMessage({
        type: "status",
        status: `Finished (RTFx: ${rtfx.toFixed(2)}x)`,
        state: "idle",
        metrics: { rtfx, genTime, totalTime, audioDuration: audioSeconds },
    });
}
