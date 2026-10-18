const SAMPLE_RATE = 24000;

// WAV file encoder (16-bit PCM, mono)
export function encodeWAV(samples, sampleRate = 24000) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    // RIFF chunk descriptor
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(view, 8, 'WAVE');

    // fmt sub-chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true);  // AudioFormat (1 for PCM)
    view.setUint16(22, 1, true);  // NumChannels (1 mono)
    view.setUint32(24, sampleRate, true); // SampleRate
    view.setUint32(28, sampleRate * 2, true); // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
    view.setUint16(32, 2, true);  // BlockAlign (NumChannels * BitsPerSample/8)
    view.setUint16(34, 16, true); // BitsPerSample (16 bits)

    // data sub-chunk
    writeString(view, 36, 'data');
    view.setUint32(40, samples.length * 2, true);

    // PCM samples
    let offset = 44;
    for (let i = 0; i < samples.length; i++) {
        let s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        offset += 2;
    }

    return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

// Convert any AudioBuffer to 24000Hz mono Float32Array
export async function resampleTo24kMono(audioBuffer) {
    const offlineCtx = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * SAMPLE_RATE), SAMPLE_RATE);
    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineCtx.destination);
    source.start(0);
    const rendered = await offlineCtx.startRendering();
    return rendered.getChannelData(0);
}

// Audio Biquad Filter single pass helper
function biquadPass(samples, b0, b1, b2, a1, a2) {
    const out = new Float32Array(samples.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < samples.length; i++) {
        const x0 = samples[i];
        const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        out[i] = y0;
        x2 = x1;
        x1 = x0;
        y2 = y1;
        y1 = y0;
    }
    return out;
}

// Zero-phase Butterworth High-Pass Filter (eliminates DC offset, 50/60Hz AC hum, desk thumps with ZERO phase distortion)
export function zeroPhaseHighPass(samples, sampleRate = 24000, cutoff = 80) {
    const Q = 0.7071;
    const omega = 2 * Math.PI * cutoff / sampleRate;
    const alpha = Math.sin(omega) / (2 * Q);
    const cosw = Math.cos(omega);

    const b0 = (1 + cosw) / 2;
    const b1 = -(1 + cosw);
    const b2 = (1 + cosw) / 2;
    const a0 = 1 + alpha;
    const a1 = -2 * cosw;
    const a2 = 1 - alpha;

    const nb0 = b0 / a0;
    const nb1 = b1 / a0;
    const nb2 = b2 / a0;
    const na1 = a1 / a0;
    const na2 = a2 / a0;

    // Forward pass
    const fwd = biquadPass(samples, nb0, nb1, nb2, na1, na2);
    // Backward pass
    fwd.reverse();
    const bwd = biquadPass(fwd, nb0, nb1, nb2, na1, na2);
    bwd.reverse();
    return bwd;
}

// Studio-Grade Instant Voice Cleaner & Background Noise Remover
// 1. Zero-phase 80Hz rumble/hum elimination
// 2. Smooth downward expander / gate for dead silence during speech pauses
// 3. Leading and trailing room silence trimming
// 4. Peak normalization (-1.0 dBFS)
export function cleanVoiceAudio(samples, sampleRate = 24000) {
    if (!samples || samples.length === 0) return samples;

    // 1. High-Pass filter at 80Hz (zero-phase)
    const hpFiltered = zeroPhaseHighPass(samples, sampleRate, 80);

    // 2. RMS Energy calculation in 20ms frames
    const frameSize = Math.floor(sampleRate * 0.02); // 480 samples @ 24k
    const numFrames = Math.floor(hpFiltered.length / frameSize);
    if (numFrames < 5) return hpFiltered;

    const frameEnergies = new Float32Array(numFrames);
    for (let f = 0; f < numFrames; f++) {
        let sumSq = 0;
        const start = f * frameSize;
        for (let i = 0; i < frameSize; i++) {
            const v = hpFiltered[start + i];
            sumSq += v * v;
        }
        frameEnergies[f] = Math.sqrt(sumSq / frameSize);
    }

    // Estimate room noise floor from the quietest 15% of frames
    const sortedEnergies = Float32Array.from(frameEnergies).sort();
    const noiseFloorIdx = Math.max(0, Math.floor(numFrames * 0.15));
    const estimatedNoiseFloor = sortedEnergies[noiseFloorIdx];

    // Speech threshold: minimum energy required to be recognized as vocal phonemes
    const speechThreshold = Math.max(0.008, estimatedNoiseFloor * 2.8);

    // 3. Smooth Downward Expander (Noise Gate): Creates dead silence between spoken words without clipping
    const gated = new Float32Array(hpFiltered.length);
    let gain = 1.0;
    const attackCoeff = Math.exp(-1 / (sampleRate * 0.008)); // 8ms fast attack to preserve vocal onset
    const releaseCoeff = Math.exp(-1 / (sampleRate * 0.060)); // 60ms smooth release to prevent gating flutter

    for (let f = 0; f < numFrames; f++) {
        const energy = frameEnergies[f];
        let targetGain = 1.0;
        if (energy < speechThreshold) {
            const ratio = Math.max(0, energy / speechThreshold);
            // Attenuates down by ~26 dB in silent intervals
            targetGain = 0.03 + 0.97 * Math.pow(ratio, 2);
        }

        const start = f * frameSize;
        for (let i = 0; i < frameSize; i++) {
            const coeff = targetGain > gain ? attackCoeff : releaseCoeff;
            gain = coeff * gain + (1 - coeff) * targetGain;
            gated[start + i] = hpFiltered[start + i] * gain;
        }
    }
    for (let i = numFrames * frameSize; i < hpFiltered.length; i++) {
        gated[i] = hpFiltered[i] * gain;
    }

    // 4. Trim leading and trailing empty silence safely
    let trimmed = gated;
    let startFrame = 0;
    while (startFrame < numFrames && frameEnergies[startFrame] < speechThreshold * 1.1) {
        startFrame++;
    }
    let endFrame = numFrames - 1;
    while (endFrame > startFrame && frameEnergies[endFrame] < speechThreshold * 1.1) {
        endFrame--;
    }

    if (startFrame < endFrame) {
        const paddingSamples = Math.floor(sampleRate * 0.15);
        const startIndex = Math.max(0, startFrame * frameSize - paddingSamples);
        const endIndex = Math.min(gated.length, (endFrame + 1) * frameSize + paddingSamples);
        if (endIndex > startIndex && endIndex - startIndex > sampleRate * 1.0) {
            trimmed = gated.slice(startIndex, endIndex);
        }
    }

    // 5. Peak Normalization to -1.0 dBFS (0.89) to feed optimal dynamic range into neural latent encoder
    let maxVal = 0;
    for (let i = 0; i < trimmed.length; i++) {
        const abs = Math.abs(trimmed[i]);
        if (abs > maxVal) maxVal = abs;
    }

    if (maxVal > 0.001) {
        const scale = 0.89 / maxVal;
        for (let i = 0; i < trimmed.length; i++) {
            trimmed[i] *= scale;
        }
    }

    return trimmed;
}

// Local Storage for Private Cloned Voices (IndexedDB)
export class VoiceStorage {
    static DB_NAME = "VocoSpeechDB";
    static DB_VERSION = 1;
    static STORE_NAME = "voices";

    static async openDB() {
        return new Promise((resolve, reject) => {
            if (typeof indexedDB === "undefined") {
                reject(new Error("IndexedDB is not supported in this browser"));
                return;
            }
            const request = indexedDB.open(VoiceStorage.DB_NAME, VoiceStorage.DB_VERSION);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(VoiceStorage.STORE_NAME)) {
                    db.createObjectStore(VoiceStorage.STORE_NAME, { keyPath: "id" });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    static async getAllVoices() {
        try {
            const db = await VoiceStorage.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(VoiceStorage.STORE_NAME, "readonly");
                const store = transaction.objectStore(VoiceStorage.STORE_NAME);
                const req = store.getAll();
                req.onsuccess = () => {
                    const list = req.result || [];
                    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
                    resolve(list);
                };
                req.onerror = () => reject(req.error);
            });
        } catch (err) {
            console.warn("IndexedDB getAllVoices warning:", err);
            return [];
        }
    }

    static async getVoice(id) {
        try {
            const db = await VoiceStorage.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(VoiceStorage.STORE_NAME, "readonly");
                const store = transaction.objectStore(VoiceStorage.STORE_NAME);
                const req = store.get(id);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => reject(req.error);
            });
        } catch (err) {
            console.warn("IndexedDB getVoice warning:", err);
            return null;
        }
    }

    static async saveVoice(voiceRecord) {
        const db = await VoiceStorage.openDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(VoiceStorage.STORE_NAME, "readwrite");
            const store = transaction.objectStore(VoiceStorage.STORE_NAME);
            const req = store.put(voiceRecord);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    static async deleteVoice(id) {
        const db = await VoiceStorage.openDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(VoiceStorage.STORE_NAME, "readwrite");
            const store = transaction.objectStore(VoiceStorage.STORE_NAME);
            const req = store.delete(id);
            req.onsuccess = () => resolve(true);
            req.onerror = () => reject(req.error);
        });
    }
}

export class PocketTTSClient {
    constructor() {
        this.worker = null;
        this.isGenerating = false;
        this.isWorkerReady = false;

        this.availableVoices = [];
        this.currentVoice = "alba";
        this.currentLanguage = "english_2026-04";
        this.currentSampleRate = SAMPLE_RATE;

        this.currentGenerationChunks = [];
        this.lastCompletedAudioUrl = null;
        this.lastCompletedAudioBlob = null;
        this.generationStartTime = 0;
        this.firstChunkReceived = false;

        // Custom cloned voice state
        this.pendingClonedAudio = null;
        this.pendingPreviewBlob = null;
        this.clonedVoiceAudioUrl = null;
        this.pendingSaveVoiceData = null;

        // Recording state
        this.mediaRecorder = null;
        this.mediaStream = null;
        this.recordedChunks = [];
        this.isRecording = false;
        this.recordingTimer = null;
        this.recordingSeconds = 0;

        // Live Microphone Audio Visualizer
        this.micAudioContext = null;
        this.micSource = null;
        this.micAnalyser = null;
        this.micAnimFrameId = null;

        // Output Audio Playback Visualizer
        this.playbackCtx = null;
        this.playbackAnalyser = null;
        this.playbackSourceConnected = false;
        this.animFrameId = null;

        this.initDomElements();
        this.attachEvents();
        this.initWorker();
        this.initVisualizer();
        this.initMicVisualizer();
        this.refreshSavedVoicesList();
    }

    initDomElements() {
        this.el = {
            // Mode Tabs
            tabTts: document.getElementById("tab-tts"),
            tabClone: document.getElementById("tab-clone"),
            panelTts: document.getElementById("panel-tts"),
            panelClone: document.getElementById("panel-clone"),
            ttsGenerationArea: document.getElementById("tts-generation-area"),
            shortcutCloneVoice: document.getElementById("shortcut-clone-voice"),

            // Common Inputs
            textInput: document.getElementById("text-input"),
            charCount: document.getElementById("char-count"),
            languageSelect: document.getElementById("language-select"),
            voiceSelect: document.getElementById("voice-select"),
            temperatureSlider: document.getElementById("temperature-slider"),
            temperatureVal: document.getElementById("temperature-val"),

            // Buttons
            generateBtn: document.getElementById("generate-btn"),
            stopBtn: document.getElementById("stop-btn"),
            btnContent: document.getElementById("btn-content"),
            btnLoader: document.getElementById("btn-loader"),
            btnText: document.getElementById("btn-text"),

            // Model Loading / Progress (Hidden background items)
            modelProgressContainer: document.getElementById("model-progress-container"),
            modelProgressBar: document.getElementById("model-progress-bar"),
            modelProgressText: document.getElementById("model-progress-text"),
            modelStatusDot: document.getElementById("model-status-dot"),
            modelStatusText: document.getElementById("model-status-text"),

            // Stats / Metrics
            statStatus: document.getElementById("stat-status"),
            statTTFB: document.getElementById("stat-ttfb"),
            statRTFx: document.getElementById("stat-rtfx"),
            statDuration: document.getElementById("stat-duration"),
            ttfbBar: document.getElementById("ttfb-bar"),

            // Voice Cloning Elements
            recordBtn: document.getElementById("record-btn"),
            recordBtnText: document.getElementById("record-btn-text"),
            recordTimer: document.getElementById("record-timer"),
            micStatusText: document.getElementById("mic-status-text"),
            micVisualizerCanvas: document.getElementById("mic-visualizer-canvas"),
            micLiveDot: document.getElementById("mic-live-dot"),
            micVisualizerHint: document.getElementById("mic-visualizer-hint"),

            // Voice Cloning Save Step
            cloneSaveStep: document.getElementById("clone-save-step"),
            cloneSampleDuration: document.getElementById("clone-sample-duration"),
            voicePreviewAudio: document.getElementById("voice-preview-audio"),
            reRecordBtn: document.getElementById("re-record-btn"),
            cloneVoiceName: document.getElementById("clone-voice-name"),
            cloneConsentCheckbox: document.getElementById("clone-consent-checkbox"),
            cloneConsentWarning: document.getElementById("clone-consent-warning"),
            saveCloneBtn: document.getElementById("save-clone-btn"),
            saveCloneBtnContent: document.getElementById("save-clone-btn-content"),
            saveCloneBtnText: document.getElementById("save-clone-btn-text"),
            saveCloneBtnLoader: document.getElementById("save-clone-btn-loader"),
            cloneSuccessAlert: document.getElementById("clone-success-alert"),
            cloneSuccessName: document.getElementById("clone-success-name"),
            cloneSuccessCta: document.getElementById("clone-success-cta"),

            // Saved Voices Library
            savedVoicesContainer: document.getElementById("saved-voices-container"),
            savedVoicesCount: document.getElementById("saved-voices-count"),

            // Audio Player & Visualizer (TTS Output)
            visualizerCanvas: document.getElementById("visualizer-canvas"),
            playBtn: document.getElementById("play-audio-btn"),
            downloadBtn: document.getElementById("download-audio-btn"),
            audioPlayback: document.getElementById("audio-playback"),
            audioDurationText: document.getElementById("audio-duration-text"),

            // Storage Cache
            cacheStatusBadge: document.getElementById("cache-status-badge"),
            clearCacheBtn: document.getElementById("clear-cache-btn"),
        };
    }

    attachEvents() {
        // Tab switching
        if (this.el.tabTts && this.el.tabClone) {
            this.el.tabTts.addEventListener("click", () => this.switchTab("tts"));
            this.el.tabClone.addEventListener("click", () => this.switchTab("clone"));
        }

        // Shortcut to switch to clone tab from TTS voice card
        if (this.el.shortcutCloneVoice) {
            this.el.shortcutCloneVoice.addEventListener("click", () => {
                this.switchTab("clone");
            });
        }

        // Text input character count
        if (this.el.textInput) {
            this.el.textInput.addEventListener("input", () => {
                if (this.el.charCount) {
                    this.el.charCount.textContent = this.el.textInput.value.length;
                }
            });
        }

        // Sample text presets
        document.querySelectorAll(".sample-preset-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                const text = btn.getAttribute("data-text");
                if (text && this.el.textInput) {
                    this.el.textInput.value = text;
                    if (this.el.charCount) {
                        this.el.charCount.textContent = text.length;
                    }
                    this.el.textInput.focus();
                }
            });
        });

        // Language Select
        if (this.el.languageSelect) {
            this.el.languageSelect.addEventListener("change", (e) => {
                const newLang = e.target.value;
                if (newLang !== this.currentLanguage && this.worker) {
                    this.updateStatus("Changing language...", "loading");
                    this.worker.postMessage({
                        type: "set_language",
                        data: { language: newLang }
                    });
                }
            });
        }

        // Voice Select
        if (this.el.voiceSelect) {
            this.el.voiceSelect.addEventListener("change", async (e) => {
                const voiceId = e.target.value;
                this.currentVoice = voiceId;

                const customVoice = await VoiceStorage.getVoice(voiceId);
                if (customVoice && this.worker && this.isWorkerReady) {
                    let audioFloats = null;
                    if (customVoice.audioData) {
                        audioFloats = new Float32Array(customVoice.audioData);
                    }
                    this.worker.postMessage({
                        type: "load_custom_voice",
                        data: {
                            voiceId: customVoice.id,
                            voiceName: customVoice.name,
                            embedding: customVoice.embedding,
                            audio: audioFloats,
                        }
                    });
                } else if (this.worker && this.isWorkerReady) {
                    this.worker.postMessage({
                        type: "set_voice",
                        data: { voiceName: voiceId }
                    });
                }
            });
        }

        // Temperature slider (Voice Tone)
        if (this.el.temperatureSlider) {
            this.el.temperatureSlider.addEventListener("input", (e) => {
                if (this.el.temperatureVal) {
                    this.el.temperatureVal.textContent = Number(e.target.value).toFixed(2);
                }
            });
        }

        // Generate and Stop buttons
        if (this.el.generateBtn) {
            this.el.generateBtn.addEventListener("click", () => this.handleGenerate());
        }
        if (this.el.stopBtn) {
            this.el.stopBtn.addEventListener("click", () => this.handleStop());
        }

        // Audio Player Download
        if (this.el.downloadBtn) {
            this.el.downloadBtn.addEventListener("click", () => this.handleDownload());
        }

        // Audio Player user playback listener to trigger visualizer
        if (this.el.audioPlayback) {
            this.el.audioPlayback.addEventListener("play", () => {
                this.setupPlaybackVisualizer();
                if (this.playbackCtx && this.playbackCtx.state === "suspended") {
                    this.playbackCtx.resume();
                }
            });
        }

        // Clear Cache
        if (this.el.clearCacheBtn) {
            this.el.clearCacheBtn.addEventListener("click", () => this.handleClearCache());
        }

        // Voice Cloning: Microphone Record Toggle
        if (this.el.recordBtn) {
            this.el.recordBtn.addEventListener("click", () => this.toggleRecording());
        }

        // Re-record / Discard
        if (this.el.reRecordBtn) {
            this.el.reRecordBtn.addEventListener("click", () => this.handleDiscardRecording());
        }

        // Save Voice button
        if (this.el.saveCloneBtn) {
            this.el.saveCloneBtn.addEventListener("click", () => this.handleSaveClonedVoice());
        }

        // Consent checkbox
        if (this.el.cloneConsentCheckbox) {
            this.el.cloneConsentCheckbox.addEventListener("change", (e) => {
                if (e.target.checked && this.el.cloneConsentWarning) {
                    this.el.cloneConsentWarning.classList.add("hidden");
                }
            });
        }

        // Use Voice CTA from success banner
        if (this.el.cloneSuccessCta) {
            this.el.cloneSuccessCta.addEventListener("click", () => {
                this.useSavedVoiceInTTS(this.currentVoice);
            });
        }
    }

    switchTab(mode) {
        const isTts = mode === "tts";

        if (this.el.tabTts) {
            this.el.tabTts.classList.toggle("is-active", isTts);
        }
        if (this.el.tabClone) {
            this.el.tabClone.classList.toggle("is-active", !isTts);
        }

        if (isTts) {
            this.el.panelTts?.classList.remove("hidden");
            this.el.panelClone?.classList.add("hidden");

            // Voice generator is visible ONLY on Text-to-Speech
            this.el.ttsGenerationArea?.classList.remove("hidden");
        } else {
            this.el.panelClone?.classList.remove("hidden");
            this.el.panelTts?.classList.add("hidden");

            // Remove voice generator completely from voice cloning part
            this.el.ttsGenerationArea?.classList.add("hidden");

            // Refresh saved voices library when switching to clone tab
            this.refreshSavedVoicesList();
        }
    }

    initWorker() {
        this.updateStatus("Ready", "idle");
        this.setButtonState("ready", "Generate Speech");

        this.worker = new Worker("./inference-worker.js", { type: "module" });

        this.worker.onmessage = async (e) => {
            const { type, data, error, status, state, text, voices, defaultVoice, voiceName, language, file, percent, fromCache, voiceId, embedding } = e.data;

            switch (type) {
                case "status":
                    this.updateStatus(status, state);
                    break;

                case "model_status":
                    if (this.el.modelStatusText) this.el.modelStatusText.textContent = text || status;
                    if (this.el.modelStatusDot) {
                        this.el.modelStatusDot.className = "w-2 h-2 rounded-full " + (status === "ready" ? "bg-emerald-500" : "bg-amber-500 animate-pulse");
                    }
                    break;

                case "download_progress":
                    this.handleDownloadProgress(file, percent, fromCache);
                    break;

                case "voices_loaded":
                    this.availableVoices = voices || [];
                    await this.updateVoiceDropdown(this.currentVoice || defaultVoice);
                    break;

                case "bundle_loaded":
                    this.currentLanguage = language;
                    if (e.data.sampleRate) this.currentSampleRate = e.data.sampleRate;
                    break;

                case "loaded":
                    this.isWorkerReady = true;
                    this.hideProgressBar();
                    if (this.pendingGeneration) {
                        const pending = this.pendingGeneration;
                        this.pendingGeneration = null;
                        this.startActualGeneration(pending.text, pending.voice, pending.temperature);
                    } else {
                        this.setButtonState("ready", "Generate Speech");
                    }
                    break;

                case "voice_encoded":
                    await this.onVoiceEncoded({ voiceId, voiceName, embedding });
                    break;

                case "generation_started":
                    this.generationStartTime = performance.now();
                    this.firstChunkReceived = false;
                    this.currentGenerationChunks = [];
                    if (this.el.statStatus) this.el.statStatus.textContent = "Generating speech...";
                    break;

                case "audio_chunk":
                    this.handleAudioChunk(data, e.data.metrics);
                    break;

                case "stream_ended":
                    this.handleStreamEnd();
                    break;

                case "error":
                    console.error("Worker Error:", error);
                    this.updateStatus(`Error: ${error}`, "error");
                    this.setButtonState("ready", "Generate Speech");
                    this.isGenerating = false;
                    if (this.el.saveCloneBtn) {
                        this.el.saveCloneBtn.disabled = false;
                    }
                    if (this.el.saveCloneBtnContent) {
                        this.el.saveCloneBtnContent.classList.remove("hidden");
                        this.el.saveCloneBtnContent.style.display = "";
                    }
                    if (this.el.saveCloneBtnLoader) {
                        this.el.saveCloneBtnLoader.classList.add("hidden");
                        this.el.saveCloneBtnLoader.style.display = "none";
                    }
                    if (this.el.saveCloneBtnText) {
                        this.el.saveCloneBtnText.textContent = "Save Voice";
                    }
                    break;
            }
        };

        this.worker.postMessage({ type: "load" });
    }

    handleDownloadProgress(file, percent, fromCache) {
        // Intentionally silent background fetch
    }

    hideProgressBar() {
        if (this.el.modelProgressContainer) {
            this.el.modelProgressContainer.classList.add("hidden");
        }
    }

    async updateVoiceDropdown(selectedVoiceId) {
        if (!this.el.voiceSelect) return;

        const savedVoices = await VoiceStorage.getAllVoices();
        const currentVal = selectedVoiceId || this.el.voiceSelect.value || this.currentVoice || "alba";

        this.el.voiceSelect.innerHTML = "";

        // 1. Saved Custom Voices OptGroup
        if (savedVoices.length > 0) {
            const customGroup = document.createElement("optgroup");
            customGroup.label = "Your Saved Voices";
            savedVoices.forEach((v) => {
                const opt = document.createElement("option");
                opt.value = v.id;
                opt.textContent = `${v.name} (Custom)`;
                if (v.id === currentVal) opt.selected = true;
                customGroup.appendChild(opt);
            });
            this.el.voiceSelect.appendChild(customGroup);
        }

        // 2. Default Voices OptGroup
        const standardGroup = document.createElement("optgroup");
        standardGroup.label = "Default Voices";

        const voiceDescriptions = {
            alba: "Alba (Warm & Clear, Female)",
            marius: "Marius (Natural, Male)",
            cosette: "Cosette (Gentle, Female)",
            jean: "Jean (Deep, Male)",
            fantine: "Fantine (Soft, Female)",
            javert: "Javert (Steady, Male)",
            azelma: "Azelma (Bright, Female)",
            eponine: "Eponine (Casual, Female)",
        };

        const standardVoicesList = this.availableVoices.length > 0
            ? this.availableVoices
            : ["alba", "marius", "cosette", "jean", "fantine", "javert", "azelma", "eponine"];

        standardVoicesList.forEach((v) => {
            const opt = document.createElement("option");
            opt.value = v;
            opt.textContent = voiceDescriptions[v] || (v.charAt(0).toUpperCase() + v.slice(1));
            if (v === currentVal) opt.selected = true;
            standardGroup.appendChild(opt);
        });
        this.el.voiceSelect.appendChild(standardGroup);
    }

    async handleGenerate() {
        const text = this.el.textInput?.value?.trim();
        if (!text) {
            alert("Please type or paste some text first.");
            this.el.textInput?.focus();
            return;
        }

        // Immediately disable button and show only the rotating spinner
        this.setButtonState("generating");

        let targetVoice = this.el.voiceSelect?.value || this.currentVoice || "alba";

        // Check if targetVoice is a saved custom voice
        const customVoice = await VoiceStorage.getVoice(targetVoice);
        if (customVoice && this.worker && this.isWorkerReady) {
            let audioFloats = null;
            if (customVoice.audioData) {
                audioFloats = new Float32Array(customVoice.audioData);
            }
            this.worker.postMessage({
                type: "load_custom_voice",
                data: {
                    voiceId: customVoice.id,
                    voiceName: customVoice.name,
                    embedding: customVoice.embedding,
                    audio: audioFloats,
                }
            });
        }

        const temperature = parseFloat(this.el.temperatureSlider?.value || "0.7");

        if (!this.isWorkerReady) {
            this.pendingGeneration = { text, voice: targetVoice, temperature };
            this.setButtonState("loading", "Getting ready...");
            this.updateStatus("Getting ready...", "loading");
            this.worker.postMessage({
                type: "generate",
                data: {
                    text,
                    voice: targetVoice,
                    temperature,
                }
            });
            return;
        }

        await this.startActualGeneration(text, targetVoice, temperature);
    }

    async startActualGeneration(text, targetVoice, temperature) {
        this.isGenerating = true;
        this.currentGenerationChunks = [];
        this.setButtonState("generating", "Generating speech...");
        this.updateStatus("Creating audio...", "loading");

        if (this.el.statStatus) this.el.statStatus.textContent = "Generating speech...";
        if (this.el.stopBtn) this.el.stopBtn.disabled = false;
        if (this.el.downloadBtn) this.el.downloadBtn.disabled = true;

        // Reset previous playback audio so user only hears the newly created full audio
        if (this.el.audioPlayback) {
            this.el.audioPlayback.pause();
        }

        this.worker.postMessage({
            type: "generate",
            data: {
                text,
                voice: targetVoice,
                temperature: temperature ?? parseFloat(this.el.temperatureSlider?.value || "0.7"),
            }
        });
    }

    handleStop() {
        this.pendingGeneration = null;
        if (this.worker && (this.isGenerating || !this.isWorkerReady)) {
            this.worker.postMessage({ type: "stop" });
        }
        this.isGenerating = false;
        this.setButtonState("ready", "Generate Speech");
        if (this.el.stopBtn) this.el.stopBtn.disabled = true;
        this.updateStatus("Stopped", "idle");
        if (this.el.statStatus) this.el.statStatus.textContent = "Stopped";
    }

    // Audio is collected silently in memory while generating.
    // Chunks are NOT played piece-by-piece to avoid choppy premature sound!
    handleAudioChunk(float32Chunk, metrics) {
        if (!this.firstChunkReceived) {
            this.firstChunkReceived = true;
            const timeTakenMs = Math.round(performance.now() - this.generationStartTime);
            if (this.el.statTTFB) this.el.statTTFB.textContent = timeTakenMs;
            if (this.el.ttfbBar) {
                const pct = Math.max(5, Math.min(100, 100 - (timeTakenMs / 10)));
                this.el.ttfbBar.style.width = `${pct}%`;
            }
        }

        // Store chunk into the full buffer
        this.currentGenerationChunks.push(new Float32Array(float32Chunk));
    }

    // Full audio is assembled and ready to play once generation finishes completely!
    handleStreamEnd() {
        this.isGenerating = false;
        this.setButtonState("ready", "Generate Speech");
        if (this.el.stopBtn) this.el.stopBtn.disabled = true;

        if (this.currentGenerationChunks.length > 0) {
            const totalLength = this.currentGenerationChunks.reduce((acc, c) => acc + c.length, 0);
            const fullFloat32 = new Float32Array(totalLength);
            let offset = 0;
            for (const c of this.currentGenerationChunks) {
                fullFloat32.set(c, offset);
                offset += c.length;
            }

            const durationSec = (totalLength / this.currentSampleRate);
            if (this.el.statDuration) {
                this.el.statDuration.textContent = `${durationSec.toFixed(1)}s`;
            }

            // Encode complete WAV audio file
            const wavBlob = encodeWAV(fullFloat32, this.currentSampleRate);
            this.lastCompletedAudioBlob = wavBlob;
            if (this.lastCompletedAudioUrl) {
                URL.revokeObjectURL(this.lastCompletedAudioUrl);
            }
            this.lastCompletedAudioUrl = URL.createObjectURL(wavBlob);

            if (this.el.audioPlayback) {
                this.el.audioPlayback.src = this.lastCompletedAudioUrl;
                this.el.audioPlayback.load();
            }
            if (this.el.audioDurationText) {
                this.el.audioDurationText.textContent = `${durationSec.toFixed(1)}s`;
            }
            if (this.el.downloadBtn) {
                this.el.downloadBtn.disabled = false;
            }

            this.updateStatus("Voice ready! Press play below to listen.", "idle");
            if (this.el.statStatus) this.el.statStatus.textContent = "Ready";

            // Trigger suggestion popup after generation so users can share feedback
            setTimeout(() => {
                if (window.openSuggestionModal) {
                    window.openSuggestionModal({
                        trigger: "generation",
                        title: "How did that voice sound?",
                        subtitle: "Help shape Voco Speech. What improvements, voices, or tweaks would you suggest?"
                    });
                }
            }, 1200);
        }
    }

    handleDownload() {
        if (!this.lastCompletedAudioBlob) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(this.lastCompletedAudioBlob);
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        a.download = `voco-voice-${this.currentVoice}-${timestamp}.wav`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    // Connects audio element to Web Audio analyser when user plays the audio
    setupPlaybackVisualizer() {
        if (this.playbackSourceConnected || !this.el.audioPlayback) return;
        try {
            if (!this.playbackCtx) {
                this.playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            const source = this.playbackCtx.createMediaElementSource(this.el.audioPlayback);
            this.playbackAnalyser = this.playbackCtx.createAnalyser();
            this.playbackAnalyser.fftSize = 64;
            source.connect(this.playbackAnalyser);
            this.playbackAnalyser.connect(this.playbackCtx.destination);
            this.playbackSourceConnected = true;
        } catch (e) {
            console.warn("Playback visualizer note:", e);
        }
    }

    // ==========================================
    // VOICE CLONING: MICROPHONE RECORDING & SPECTRUM
    // ==========================================

    initMicVisualizer() {
        const canvas = this.el.micVisualizerCanvas;
        if (!canvas) return;

        const resize = () => {
            canvas.width = canvas.parentElement?.clientWidth || 600;
            canvas.height = 80;
            this.drawMicIdle();
        };
        resize();
        window.addEventListener("resize", resize);
    }

    drawMicIdle() {
        const canvas = this.el.micVisualizerCanvas;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Draw subtle static horizontal baseline
        ctx.beginPath();
        ctx.strokeStyle = "rgba(20, 20, 19, 0.15)";
        ctx.lineWidth = 1.5;
        ctx.moveTo(0, canvas.height / 2);
        ctx.lineTo(canvas.width, canvas.height / 2);
        ctx.stroke();
    }

    startMicVisualizer(stream) {
        const canvas = this.el.micVisualizerCanvas;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");

        try {
            if (!this.micAudioContext || this.micAudioContext.state === "closed") {
                this.micAudioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (this.micAudioContext.state === "suspended") {
                this.micAudioContext.resume();
            }

            this.micSource = this.micAudioContext.createMediaStreamSource(stream);
            this.micAnalyser = this.micAudioContext.createAnalyser();
            this.micAnalyser.fftSize = 128;
            this.micAnalyser.smoothingTimeConstant = 0.75;

            // Connect ONLY to analyser to avoid feedback!
            this.micSource.connect(this.micAnalyser);

            const bufferLength = this.micAnalyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);

            if (this.el.micLiveDot) {
                this.el.micLiveDot.className = "w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse";
            }
            if (this.el.micVisualizerHint) {
                this.el.micVisualizerHint.textContent = "Recording voice";
                this.el.micVisualizerHint.className = "text-[10px] font-bold text-red-600 uppercase tracking-wider animate-pulse";
            }

            const renderFrame = () => {
                if (!this.isRecording) {
                    this.drawMicIdle();
                    return;
                }
                this.micAnimFrameId = requestAnimationFrame(renderFrame);

                this.micAnalyser.getByteFrequencyData(dataArray);
                ctx.clearRect(0, 0, canvas.width, canvas.height);

                const numBars = 48;
                const barWidth = Math.floor(canvas.width / numBars) - 2;
                const step = Math.floor(bufferLength / numBars) || 1;

                for (let i = 0; i < numBars; i++) {
                    const val = dataArray[i * step] || 0;
                    const percent = val / 255;
                    const minH = 3;
                    const barHeight = Math.max(minH, percent * (canvas.height - 10));
                    const x = i * (barWidth + 2);
                    const y = (canvas.height - barHeight) / 2;

                    const alpha = Math.min(1, 0.25 + percent * 0.75);
                    ctx.fillStyle = `rgba(20, 20, 19, ${alpha})`;
                    ctx.fillRect(x, y, barWidth, barHeight);
                }
            };

            renderFrame();
        } catch (err) {
            console.warn("Could not start mic visualizer:", err);
        }
    }

    stopMicVisualizer() {
        if (this.micAnimFrameId) {
            cancelAnimationFrame(this.micAnimFrameId);
            this.micAnimFrameId = null;
        }
        if (this.micSource) {
            try {
                this.micSource.disconnect();
            } catch (e) {}
            this.micSource = null;
        }
        if (this.el.micLiveDot) {
            this.el.micLiveDot.className = "w-2.5 h-2.5 rounded-full bg-neutral-300";
        }
        if (this.el.micVisualizerHint) {
            this.el.micVisualizerHint.textContent = "Waiting for mic";
            this.el.micVisualizerHint.className = "text-[10px] font-bold text-[#5c5b56] uppercase tracking-wider";
        }
        this.drawMicIdle();
    }

    async toggleRecording() {
        if (this.isRecording) {
            this.stopRecording();
        } else {
            await this.startRecording();
        }
    }

    async startRecording() {
        try {
            const audioConstraints = {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
            };
            const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
            this.mediaStream = stream;
            this.mediaRecorder = new MediaRecorder(stream);
            this.recordedChunks = [];
            this.recordingSeconds = 0;

            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) {
                    this.recordedChunks.push(e.data);
                }
            };

            this.mediaRecorder.onstop = async () => {
                this.stopMicVisualizer();
                stream.getTracks().forEach((track) => track.stop());
                const blob = new Blob(this.recordedChunks, { type: "audio/webm" });
                await this.handleRecordingFinished(blob);
            };

            this.mediaRecorder.start();
            this.isRecording = true;
            this.startMicVisualizer(stream);

            if (this.el.recordBtn) {
                this.el.recordBtn.classList.remove("bg-[#141413]", "hover:bg-neutral-800");
                this.el.recordBtn.classList.add("bg-red-600", "hover:bg-red-700");
            }
            if (this.el.recordBtnText) {
                this.el.recordBtnText.textContent = "Stop Recording";
            }
            if (this.el.micStatusText) {
                this.el.micStatusText.textContent = "Recording... Speak naturally or read the sentence, then click Stop Recording when done.";
                this.el.micStatusText.className = "text-xs text-red-600 font-bold animate-pulse";
            }
            if (this.el.recordTimer) {
                this.el.recordTimer.classList.remove("hidden");
                this.el.recordTimer.textContent = "00:00 / 00:30";
            }

            this.recordingTimer = setInterval(() => {
                this.recordingSeconds++;
                const secs = String(this.recordingSeconds).padStart(2, "0");
                if (this.el.recordTimer) {
                    this.el.recordTimer.textContent = `00:${secs} / 00:30`;
                }

                if (this.recordingSeconds >= 10 && this.el.micStatusText) {
                    this.el.micStatusText.textContent = "Good sample length reached. Click Stop Recording when finished.";
                }

                // Generous safety cap of 30 seconds so no one gets cut off mid-sentence
                if (this.recordingSeconds >= 30) {
                    this.stopRecording();
                }
            }, 1000);
        } catch (err) {
            console.error("Microphone access error:", err);
            alert("Could not access microphone: " + err.message + "\nPlease make sure microphone permissions are granted in your browser.");
        }
    }

    stopRecording() {
        if (this.mediaRecorder && this.isRecording) {
            this.mediaRecorder.stop();
            this.isRecording = false;
            clearInterval(this.recordingTimer);

            if (this.el.recordBtn) {
                this.el.recordBtn.classList.remove("bg-red-600", "hover:bg-red-700");
                this.el.recordBtn.classList.add("bg-[#141413]", "hover:bg-neutral-800");
            }
            if (this.el.recordBtnText) {
                this.el.recordBtnText.textContent = "Record with Microphone";
            }
            if (this.el.micStatusText) {
                this.el.micStatusText.textContent = "Processing voice sample...";
                this.el.micStatusText.className = "text-xs text-[#141413] font-medium";
            }
            if (this.el.recordTimer) {
                this.el.recordTimer.classList.add("hidden");
            }
        }
    }

    async handleRecordingFinished(blob) {
        try {
            const arrayBuffer = await blob.arrayBuffer();
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);

            // Resample to 24000Hz mono Float32Array
            const rawAudio = await resampleTo24kMono(decodedBuffer);

            // Instant Background Noise Remover & Acoustic Cleaner
            // Strips room hum, fan noise, desk rumble, and silence before sending to AI encoder
            const cleanedAudio = cleanVoiceAudio(rawAudio, SAMPLE_RATE);
            const durationSec = cleanedAudio.length / SAMPLE_RATE;

            if (durationSec < 1.0) {
                alert("Recording was too short. Please speak for at least 2 to 3 seconds so the computer can capture your voice.");
                if (this.el.micStatusText) {
                    this.el.micStatusText.textContent = "Recording was too short. Please try again.";
                    this.el.micStatusText.className = "text-xs text-amber-600 font-medium";
                }
                return;
            }

            this.pendingClonedAudio = cleanedAudio;

            // Create preview WAV blob of the cleaned audio
            const previewBlob = encodeWAV(cleanedAudio, SAMPLE_RATE);
            this.pendingPreviewBlob = previewBlob;

            if (this.clonedVoiceAudioUrl) {
                URL.revokeObjectURL(this.clonedVoiceAudioUrl);
            }
            this.clonedVoiceAudioUrl = URL.createObjectURL(previewBlob);

            if (this.el.voicePreviewAudio) {
                this.el.voicePreviewAudio.src = this.clonedVoiceAudioUrl;
                this.el.voicePreviewAudio.load();
            }

            if (this.el.cloneSampleDuration) {
                this.el.cloneSampleDuration.textContent = `${durationSec.toFixed(1)}s clean sample`;
            }

            // Suggest a default voice name based on existing saved voices count
            const allVoices = await VoiceStorage.getAllVoices();
            const nextNum = allVoices.length + 1;
            if (this.el.cloneVoiceName) {
                this.el.cloneVoiceName.value = `My Voice ${nextNum}`;
            }

            // Hide success alert if previously shown
            if (this.el.cloneSuccessAlert) {
                this.el.cloneSuccessAlert.classList.add("hidden");
            }

            // Reveal Step 2: Listen & Name
            if (this.el.cloneSaveStep) {
                this.el.cloneSaveStep.classList.remove("hidden");
                this.el.cloneSaveStep.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }

            if (this.el.micStatusText) {
                this.el.micStatusText.textContent = "Listen to preview and name your voice below.";
                this.el.micStatusText.className = "text-xs text-emerald-700 font-bold";
            }
        } catch (err) {
            console.error("Audio processing error:", err);
            alert("Could not process microphone recording: " + err.message);
        }
    }

    handleDiscardRecording() {
        this.pendingClonedAudio = null;
        this.pendingPreviewBlob = null;
        if (this.clonedVoiceAudioUrl) {
            URL.revokeObjectURL(this.clonedVoiceAudioUrl);
            this.clonedVoiceAudioUrl = null;
        }
        if (this.el.voicePreviewAudio) {
            this.el.voicePreviewAudio.pause();
            this.el.voicePreviewAudio.removeAttribute("src");
            this.el.voicePreviewAudio.load();
        }
        if (this.el.cloneSaveStep) {
            this.el.cloneSaveStep.classList.add("hidden");
        }
        if (this.el.micStatusText) {
            this.el.micStatusText.textContent = "Click record and speak anything or read the sentence.";
            this.el.micStatusText.className = "text-xs text-[#5c5b56] font-medium";
        }
    }

    async handleSaveClonedVoice() {
        if (!this.pendingClonedAudio) {
            alert("Please record your voice first.");
            return;
        }

        // Auto-check permission if not already checked
        if (this.el.cloneConsentCheckbox && !this.el.cloneConsentCheckbox.checked) {
            this.el.cloneConsentCheckbox.checked = true;
        }
        if (this.el.cloneConsentWarning) {
            this.el.cloneConsentWarning.classList.add("hidden");
        }

        const voiceName = this.el.cloneVoiceName?.value?.trim() || "My Voice";
        const voiceId = "voice_" + Date.now();

        if (this.el.saveCloneBtn) {
            this.el.saveCloneBtn.disabled = true;
        }
        if (this.el.saveCloneBtnContent) {
            this.el.saveCloneBtnContent.classList.add("hidden");
            this.el.saveCloneBtnContent.style.setProperty("display", "none", "important");
        }
        if (this.el.saveCloneBtnLoader) {
            this.el.saveCloneBtnLoader.classList.remove("hidden");
            this.el.saveCloneBtnLoader.style.setProperty("display", "inline-flex", "important");
        }

        const durationSec = this.pendingClonedAudio.length / SAMPLE_RATE;

        // Create the complete voice record immediately!
        // We store audioData as a standard Array so IndexedDB serializes it flawlessly across all browsers
        const saveRecord = {
            id: voiceId,
            name: voiceName,
            createdAt: Date.now(),
            duration: durationSec,
            audioData: Array.from(this.pendingClonedAudio),
            audioSampleBlob: this.pendingPreviewBlob || null,
            embedding: null,
        };

        try {
            // Save immediately into IndexedDB so the user's voice profile is never lost
            await VoiceStorage.saveVoice(saveRecord);

            // Display success alert
            if (this.el.cloneSuccessName) {
                this.el.cloneSuccessName.textContent = saveRecord.name;
            }
            if (this.el.cloneSuccessAlert) {
                this.el.cloneSuccessAlert.classList.remove("hidden");
                this.el.cloneSuccessAlert.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }

            this.currentVoice = voiceId;

            // Refresh Saved Voices Library and voice dropdown right away
            await this.refreshSavedVoicesList();
            await this.updateVoiceDropdown(this.currentVoice);

            this.updateStatus(`Voice "${saveRecord.name}" saved safely on this device`, "idle");

            setTimeout(() => {
                if (window.openSuggestionModal) {
                    window.openSuggestionModal({
                        trigger: "voice_saved",
                        title: "Voice Profile Created",
                        subtitle: "What other voice cloning options or settings would you like to see?"
                    });
                }
            }, 1200);
        } catch (storageErr) {
            console.error("IndexedDB save error:", storageErr);
            alert("Could not save voice to browser storage: " + storageErr.message);
        } finally {
            if (this.el.saveCloneBtn) {
                this.el.saveCloneBtn.disabled = false;
            }
            if (this.el.saveCloneBtnContent) {
                this.el.saveCloneBtnContent.classList.remove("hidden");
                this.el.saveCloneBtnContent.style.display = "";
            }
            if (this.el.saveCloneBtnLoader) {
                this.el.saveCloneBtnLoader.classList.add("hidden");
                this.el.saveCloneBtnLoader.style.display = "none";
            }
            if (this.el.saveCloneBtnText) {
                this.el.saveCloneBtnText.textContent = "Save Voice";
            }
        }

        // Send to Web Worker to encode acoustic features in the background if worker is ready
        if (this.worker && this.isWorkerReady) {
            this.worker.postMessage({
                type: "encode_voice",
                data: {
                    audio: this.pendingClonedAudio,
                    voiceId: voiceId,
                    voiceName: voiceName,
                }
            });
        }
    }

    async onVoiceEncoded({ voiceId, voiceName, embedding }) {
        try {
            const existing = await VoiceStorage.getVoice(voiceId);
            if (existing) {
                existing.embedding = embedding;
                await VoiceStorage.saveVoice(existing);
            }
            this.updateStatus(`Voice "${voiceName}" ready for speech creation`, "idle");
        } catch (e) {
            console.warn("Could not update embedding in IndexedDB:", e);
        }
    }

    async useSavedVoiceInTTS(voiceId) {
        const voice = await VoiceStorage.getVoice(voiceId);
        if (!voice) return;

        this.currentVoice = voice.id;

        // 1. Switch to TTS tab
        this.switchTab("tts");

        // 2. Select in voice dropdown
        await this.updateVoiceDropdown(voice.id);
        if (this.el.voiceSelect) {
            this.el.voiceSelect.value = voice.id;
        }

        // 3. Load into worker
        if (this.worker && this.isWorkerReady) {
            let audioFloats = null;
            if (voice.audioData) {
                audioFloats = new Float32Array(voice.audioData);
            }
            this.worker.postMessage({
                type: "load_custom_voice",
                data: {
                    voiceId: voice.id,
                    voiceName: voice.name,
                    embedding: voice.embedding,
                    audio: audioFloats,
                }
            });
        }

        // 4. Focus text input
        if (this.el.textInput) {
            this.el.textInput.focus();
            this.el.textInput.scrollIntoView({ behavior: "smooth", block: "center" });
        }
    }

    async refreshSavedVoicesList() {
        const voices = await VoiceStorage.getAllVoices();
        if (this.el.savedVoicesCount) {
            this.el.savedVoicesCount.textContent = voices.length;
        }

        const container = this.el.savedVoicesContainer;
        if (!container) return;

        if (voices.length === 0) {
            container.innerHTML = `
                <div class="p-6 bg-[#fbf9f5] border border-[#e5e0d4] text-center text-xs text-[#5c5b56]">
                    No custom voices saved yet. Record your voice using the microphone above to save your first private voice.
                </div>
            `;
            return;
        }

        container.innerHTML = "";

        voices.forEach((v) => {
            const card = document.createElement("div");
            card.className = "p-4 bg-[#fbf9f5] border border-[#141413] flex flex-col md:flex-row md:items-center justify-between gap-3 rebus-stamp-shadow-sm";

            const dateStr = new Date(v.createdAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit"
            });

            const durationStr = v.duration ? `${Number(v.duration).toFixed(1)}s sample` : "Voice sample";

            let sampleAudioUrl = null;
            if (v.audioSampleBlob) {
                sampleAudioUrl = URL.createObjectURL(v.audioSampleBlob);
            }

            card.innerHTML = `
                <div class="flex items-center space-x-3">
                    <div class="w-8 h-8 bg-[#141413] text-white flex items-center justify-center font-bold text-xs shrink-0">
                        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                            <line x1="12" y1="19" x2="12" y2="22" />
                        </svg>
                    </div>
                    <div>
                        <div class="flex items-center space-x-2">
                            <span class="text-xs font-bold text-[#141413] uppercase tracking-wider">${v.name}</span>
                            <span class="text-[10px] bg-white border border-[#141413] px-1.5 py-0.2 font-bold text-[#141413] uppercase">Private</span>
                        </div>
                        <span class="text-[11px] text-[#5c5b56]">${durationStr} • Stored ${dateStr}</span>
                    </div>
                </div>

                <div class="flex flex-wrap items-center gap-2">
                    ${sampleAudioUrl ? `
                        <audio src="${sampleAudioUrl}" controls class="h-8 w-44"></audio>
                    ` : ""}
                    <button
                        type="button"
                        class="use-voice-btn px-3 py-1.5 bg-[#141413] text-white text-xs font-bold uppercase tracking-wider hover:bg-neutral-800 transition-colors cursor-pointer border border-[#141413]"
                        data-voice-id="${v.id}"
                    >
                        Use this Voice →
                    </button>
                    <button
                        type="button"
                        class="delete-voice-btn p-2 text-neutral-500 hover:text-red-600 hover:bg-red-50 border border-neutral-300 hover:border-red-300 transition-colors cursor-pointer rounded-none inline-flex items-center justify-center"
                        data-voice-id="${v.id}"
                        title="Delete voice"
                        aria-label="Delete voice"
                    >
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                    </button>
                </div>
            `;

            const useBtn = card.querySelector(".use-voice-btn");
            useBtn?.addEventListener("click", () => {
                this.useSavedVoiceInTTS(v.id);
            });

            const delBtn = card.querySelector(".delete-voice-btn");
            delBtn?.addEventListener("click", async () => {
                if (confirm(`Are you sure you want to delete the saved voice "${v.name}"?`)) {
                    await VoiceStorage.deleteVoice(v.id);
                    if (this.currentVoice === v.id) {
                        this.currentVoice = "alba";
                    }
                    await this.refreshSavedVoicesList();
                    await this.updateVoiceDropdown(this.currentVoice);
                }
            });

            container.appendChild(card);
        });
    }

    setButtonState(state, text) {
        if (!this.el.generateBtn) return;
        if (state === "loading" || state === "generating") {
            this.el.generateBtn.disabled = true;
            if (this.el.btnContent) {
                this.el.btnContent.classList.add("hidden");
                this.el.btnContent.style.setProperty("display", "none", "important");
            }
            if (this.el.btnLoader) {
                this.el.btnLoader.classList.remove("hidden");
                this.el.btnLoader.style.setProperty("display", "inline-flex", "important");
            }
        } else {
            this.el.generateBtn.disabled = false;
            if (this.el.btnContent) {
                this.el.btnContent.classList.remove("hidden");
                this.el.btnContent.style.display = "";
            }
            if (this.el.btnLoader) {
                this.el.btnLoader.classList.add("hidden");
                this.el.btnLoader.style.display = "none";
            }
            if (this.el.btnText) {
                this.el.btnText.textContent = text || "Generate Speech";
            }
        }
    }

    updateStatus(status, state = "idle") {
        if (this.el.statStatus) {
            this.el.statStatus.textContent = status;
        }
    }

    initVisualizer() {
        const canvas = this.el.visualizerCanvas;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");

        const resize = () => {
            canvas.width = canvas.parentElement?.clientWidth || 600;
            canvas.height = 80;
        };
        resize();
        window.addEventListener("resize", resize);

        const bufferLength = 64;
        const dataArray = new Uint8Array(bufferLength);
        let phase = 0;

        const render = () => {
            this.animFrameId = requestAnimationFrame(render);
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            const isAudioPlaying = this.el.audioPlayback && !this.el.audioPlayback.paused && !this.el.audioPlayback.ended;

            // When the user plays audio in the player, show real-time reacting frequency bars
            if (this.playbackAnalyser && isAudioPlaying) {
                this.playbackAnalyser.getByteFrequencyData(dataArray);

                const barWidth = (canvas.width / bufferLength) * 1.5;
                let x = 0;

                for (let i = 0; i < bufferLength; i++) {
                    const barHeight = (dataArray[i] / 255) * canvas.height * 0.9;
                    ctx.fillStyle = `rgba(23, 23, 23, ${0.2 + (dataArray[i] / 255) * 0.8})`;

                    ctx.fillRect(x, canvas.height - barHeight, barWidth - 1, barHeight);
                    x += barWidth;
                }
            } else if (this.isGenerating) {
                // Smooth sine wave animation showing audio is actively being generated
                phase += 0.08;
                ctx.beginPath();
                ctx.strokeStyle = "rgba(23, 23, 23, 0.7)";
                ctx.lineWidth = 2;
                for (let x = 0; x < canvas.width; x += 4) {
                    const y = (canvas.height / 2) + Math.sin((x * 0.03) + phase) * 12 * Math.sin(phase * 0.5);
                    if (x === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.stroke();
            } else {
                // Static subtle resting baseline
                ctx.beginPath();
                ctx.strokeStyle = "rgba(0, 0, 0, 0.08)";
                ctx.lineWidth = 1;
                ctx.moveTo(0, canvas.height / 2);
                ctx.lineTo(canvas.width, canvas.height / 2);
                ctx.stroke();
            }
        };
        render();
    }

    async handleClearCache() {
        if (this.worker) {
            this.worker.postMessage({ type: "clear_cache" });
        }
    }
}

// Auto-initialize when DOM is ready
if (typeof window !== "undefined") {
    window.addEventListener("DOMContentLoaded", () => {
        window.pocketTTS = new PocketTTSClient();
    });
}
