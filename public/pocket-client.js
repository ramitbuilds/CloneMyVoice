import { PCMPlayerWorklet as PCMPlayer } from "./PCMPlayerWorklet.js";

const SAMPLE_RATE = 24000;
const FADE_SAMPLES = 480;

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

export class PocketTTSClient {
    constructor() {
        this.worker = null;
        this.player = null;
        this.audioContext = null;
        this.isGenerating = false;
        this.isWorkerReady = false;
        this.isVoicePreparing = false;

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
        this.clonedVoiceData = null;
        this.clonedVoiceAudioUrl = null;

        // Recording state
        this.mediaRecorder = null;
        this.recordedChunks = [];
        this.isRecording = false;
        this.recordingTimer = null;
        this.recordingSeconds = 0;

        // Audio Visualizer
        this.animFrameId = null;
        this.analyser = null;

        this.initDomElements();
        this.attachEvents();
        this.initWorker();
        this.initVisualizer();
        this.checkCacheSize();
    }

    initDomElements() {
        this.el = {
            // Mode Tabs
            tabTts: document.getElementById("tab-tts"),
            tabClone: document.getElementById("tab-clone"),
            panelTts: document.getElementById("panel-tts"),
            panelClone: document.getElementById("panel-clone"),

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
            btnLoader: document.getElementById("btn-loader"),
            btnText: document.getElementById("btn-text"),

            // Model Loading / Progress
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
            recordTimer: document.getElementById("record-timer"),
            voiceFileInput: document.getElementById("voice-file-input"),
            voiceDropzone: document.getElementById("voice-dropzone"),
            voiceFileName: document.getElementById("voice-file-name"),
            voicePreviewPlayer: document.getElementById("voice-preview-player"),
            voicePreviewAudio: document.getElementById("voice-preview-audio"),
            cloneConsentCheckbox: document.getElementById("clone-consent-checkbox"),
            cloneConsentWarning: document.getElementById("clone-consent-warning"),
            cloneStatusBadge: document.getElementById("clone-status-badge"),

            // Audio Player & Visualizer
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
                    this.updateStatus("Switching language bundle...", "loading");
                    this.worker.postMessage({
                        type: "set_language",
                        data: { language: newLang }
                    });
                }
            });
        }

        // Voice Select
        if (this.el.voiceSelect) {
            this.el.voiceSelect.addEventListener("change", (e) => {
                const voice = e.target.value;
                this.currentVoice = voice;
                if (this.worker && this.isWorkerReady) {
                    this.worker.postMessage({
                        type: "set_voice",
                        data: { voiceName: voice }
                    });
                }
            });
        }

        // Temperature slider
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

        // Clear Cache
        if (this.el.clearCacheBtn) {
            this.el.clearCacheBtn.addEventListener("click", () => this.handleClearCache());
        }

        // Voice Cloning: Microphone Record
        if (this.el.recordBtn) {
            this.el.recordBtn.addEventListener("click", () => this.toggleRecording());
        }

        // Voice Cloning: File Upload & Drag and Drop
        if (this.el.voiceFileInput) {
            this.el.voiceFileInput.addEventListener("change", (e) => {
                const file = e.target.files?.[0];
                if (file) this.processVoiceFile(file);
            });
        }

        if (this.el.voiceDropzone) {
            this.el.voiceDropzone.addEventListener("dragover", (e) => {
                e.preventDefault();
                this.el.voiceDropzone.classList.add("border-blue-500", "bg-blue-50/20");
            });
            this.el.voiceDropzone.addEventListener("dragleave", () => {
                this.el.voiceDropzone.classList.remove("border-blue-500", "bg-blue-50/20");
            });
            this.el.voiceDropzone.addEventListener("drop", (e) => {
                e.preventDefault();
                this.el.voiceDropzone.classList.remove("border-blue-500", "bg-blue-50/20");
                const file = e.dataTransfer.files?.[0];
                if (file) this.processVoiceFile(file);
            });
        }
    }

    switchTab(mode) {
        if (mode === "tts") {
            this.el.tabTts.classList.add("bg-[#171717]", "text-white");
            this.el.tabTts.classList.remove("text-neutral-500", "hover:text-neutral-900");
            this.el.tabClone.classList.remove("bg-[#171717]", "text-white");
            this.el.tabClone.classList.add("text-neutral-500", "hover:text-neutral-900");

            this.el.panelTts.classList.remove("hidden");
            this.el.panelClone.classList.add("hidden");
            if (this.el.voiceSelect) {
                if (this.currentVoice === "custom" && this.availableVoices.length > 0) {
                    this.currentVoice = this.availableVoices[0];
                    this.el.voiceSelect.value = this.currentVoice;
                }
            }
        } else {
            this.el.tabClone.classList.add("bg-[#171717]", "text-white");
            this.el.tabClone.classList.remove("text-neutral-500", "hover:text-neutral-900");
            this.el.tabTts.classList.remove("bg-[#171717]", "text-white");
            this.el.tabTts.classList.add("text-neutral-500", "hover:text-neutral-900");

            this.el.panelClone.classList.remove("hidden");
            this.el.panelTts.classList.add("hidden");
        }
    }

    async initAudioPlayer() {
        if (this.player && this.audioContext) return;

        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: SAMPLE_RATE,
                latencyHint: "interactive",
            });

            if (this.audioContext.state === "suspended") {
                await this.audioContext.resume();
            }

            this.player = new PCMPlayer(this.audioContext);
            if (this.player.initPromise) {
                await this.player.initPromise;
            }
            this.analyser = this.player.analyser;
        } catch (err) {
            console.warn("PCMPlayer initialization note:", err);
        }
    }

    initWorker() {
        this.updateStatus("Kyutai Pocket TTS Ready", "idle");
        // Keep button enabled and clickable right away
        this.setButtonState("ready", "Generate Speech");

        this.worker = new Worker("./inference-worker.js", { type: "module" });

        this.worker.onmessage = (e) => {
            const { type, data, error, status, state, text, voices, defaultVoice, voiceName, language, file, percent, fromCache } = e.data;

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
                    this.populateVoiceSelect(voices, defaultVoice);
                    break;

                case "bundle_loaded":
                    this.currentLanguage = language;
                    if (e.data.sampleRate) this.currentSampleRate = e.data.sampleRate;
                    break;

                case "loaded":
                    this.isWorkerReady = true;
                    this.hideProgressBar();
                    this.checkCacheSize();
                    if (this.pendingGeneration) {
                        const pending = this.pendingGeneration;
                        this.pendingGeneration = null;
                        this.startActualGeneration(pending.text, pending.voice, pending.temperature);
                    } else {
                        this.setButtonState("ready", "Generate Speech");
                    }
                    break;

                case "voice_encoded":
                    this.handleVoiceClonedSuccess();
                    break;

                case "generation_started":
                    this.generationStartTime = performance.now();
                    this.firstChunkReceived = false;
                    this.currentGenerationChunks = [];
                    if (this.el.statStatus) this.el.statStatus.textContent = "Synthesizing…";
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
                    break;
            }
        };

        this.worker.postMessage({ type: "load" });
    }

    handleDownloadProgress(file, percent, fromCache) {
        if (this.el.modelProgressContainer) {
            this.el.modelProgressContainer.classList.remove("hidden");
        }
        if (this.el.modelProgressBar) {
            this.el.modelProgressBar.style.width = `${percent}%`;
        }
        if (this.el.modelProgressText) {
            this.el.modelProgressText.textContent = fromCache
                ? `Cached: ${file} (100% from local disk)`
                : `Downloading: ${file} (${percent}%)`;
        }
    }

    hideProgressBar() {
        if (this.el.modelProgressContainer) {
            setTimeout(() => {
                this.el.modelProgressContainer.classList.add("hidden");
            }, 1200);
        }
    }

    populateVoiceSelect(voices, defaultVoice) {
        if (!this.el.voiceSelect) return;
        this.el.voiceSelect.innerHTML = "";

        const voiceDescriptions = {
            alba: "Alba (Warm & Clear, Female)",
            azelma: "Azelma (Bright & Expressive, Female)",
            cosette: "Cosette (Gentle & Narrative, Female)",
            eponine: "Eponine (Dynamic & Conversational, Female)",
            fantine: "Fantine (Empathetic & Resonant, Female)",
            javert: "Javert (Authoritative & Steady, Male)",
            jean: "Jean (Deep & Resonant, Male)",
            marius: "Marius (Articulate & Natural, Male)",
        };

        voices.forEach((v) => {
            const opt = document.createElement("option");
            opt.value = v;
            opt.textContent = voiceDescriptions[v] || (v.charAt(0).toUpperCase() + v.slice(1));
            if (v === defaultVoice) opt.selected = true;
            this.el.voiceSelect.appendChild(opt);
        });

        if (this.clonedVoiceData) {
            const customOpt = document.createElement("option");
            customOpt.value = "custom";
            customOpt.textContent = "Cloned Voice (Custom)";
            this.el.voiceSelect.appendChild(customOpt);
        }
    }

    async handleGenerate() {
        const text = this.el.textInput?.value?.trim();
        if (!text) {
            alert("Please enter or paste text to generate speech.");
            this.el.textInput?.focus();
            return;
        }

        const isCloneMode = !this.el.panelClone?.classList.contains("hidden");
        let targetVoice = this.currentVoice;

        if (isCloneMode) {
            if (!this.clonedVoiceData) {
                alert("Please record or upload a voice sample first to clone a voice.");
                return;
            }

            if (!this.el.cloneConsentCheckbox?.checked) {
                if (this.el.cloneConsentWarning) {
                    this.el.cloneConsentWarning.classList.remove("hidden");
                }
                alert("Permission Confirmation Required: Please check the box confirming you have permission to clone this voice.");
                this.el.cloneConsentCheckbox?.focus();
                return;
            }

            targetVoice = "custom";
        }

        const temperature = parseFloat(this.el.temperatureSlider?.value || "0.7");

        if (!this.isWorkerReady) {
            this.pendingGeneration = { text, voice: targetVoice, temperature };
            this.setButtonState("loading", "Downloading Models…");
            if (this.el.modelProgressContainer) {
                this.el.modelProgressContainer.classList.remove("hidden");
            }
            this.updateStatus("Downloading Pocket TTS models (~110MB)... Generation will start automatically.", "loading");
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
        await this.initAudioPlayer();

        if (this.player && typeof this.player.reset === "function") {
            this.player.reset();
        }

        this.isGenerating = true;
        this.setButtonState("generating", "Synthesizing…");
        if (this.el.stopBtn) this.el.stopBtn.disabled = false;
        if (this.el.downloadBtn) this.el.downloadBtn.disabled = true;

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
        if (this.player && typeof this.player.reset === "function") {
            this.player.reset();
        }
        this.isGenerating = false;
        this.setButtonState("ready", "Generate Speech");
        if (this.el.stopBtn) this.el.stopBtn.disabled = true;
        this.updateStatus("Stopped", "idle");
    }

    handleAudioChunk(float32Chunk, metrics) {
        if (!this.firstChunkReceived) {
            this.firstChunkReceived = true;
            const ttfb = Math.round(performance.now() - this.generationStartTime);
            if (this.el.statTTFB) this.el.statTTFB.textContent = ttfb;
            if (this.el.ttfbBar) {
                const pct = Math.max(5, Math.min(100, 100 - (ttfb / 10)));
                this.el.ttfbBar.style.width = `${pct}%`;
            }
        }

        // Keep copy for full WAV export
        this.currentGenerationChunks.push(new Float32Array(float32Chunk));

        // Feed to low-latency AudioWorklet player
        if (this.player && typeof this.player.playAudio === "function") {
            this.player.playAudio(float32Chunk);
        }
    }

    handleStreamEnd() {
        this.isGenerating = false;
        this.setButtonState("ready", "Generate Speech");
        if (this.el.stopBtn) this.el.stopBtn.disabled = true;

        if (this.player && typeof this.player.notifyStreamEnded === "function") {
            this.player.notifyStreamEnded();
        }

        // Assemble full audio file for download and preview
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
        }
    }

    handleDownload() {
        if (!this.lastCompletedAudioBlob) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(this.lastCompletedAudioBlob);
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        a.download = `clone-my-voice-${this.currentVoice}-${timestamp}.wav`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    // Voice Cloning: Microphone Record Toggle
    async toggleRecording() {
        if (this.isRecording) {
            this.stopRecording();
        } else {
            await this.startRecording();
        }
    }

    async startRecording() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.mediaRecorder = new MediaRecorder(stream);
            this.recordedChunks = [];
            this.recordingSeconds = 0;

            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) {
                    this.recordedChunks.push(e.data);
                }
            };

            this.mediaRecorder.onstop = async () => {
                stream.getTracks().forEach((track) => track.stop());
                const blob = new Blob(this.recordedChunks, { type: "audio/webm" });
                await this.processVoiceAudioBlob(blob, "microphone-recording.webm");
            };

            this.mediaRecorder.start();
            this.isRecording = true;

            if (this.el.recordBtn) {
                this.el.recordBtn.innerHTML = `
                    <span class="w-3 h-3 rounded-sm bg-red-500 animate-pulse inline-block mr-2"></span>
                    <span>Stop Recording</span>
                `;
                this.el.recordBtn.classList.add("border-red-500", "text-red-500");
            }

            if (this.el.recordTimer) {
                this.el.recordTimer.classList.remove("hidden");
                this.el.recordTimer.textContent = "00:00";
            }

            this.recordingTimer = setInterval(() => {
                this.recordingSeconds++;
                const mins = String(Math.floor(this.recordingSeconds / 60)).padStart(2, "0");
                const secs = String(this.recordingSeconds % 60).padStart(2, "0");
                if (this.el.recordTimer) {
                    this.el.recordTimer.textContent = `${mins}:${secs}`;
                }
                // Cap sample at 15 seconds (ideal for zero-shot cloning)
                if (this.recordingSeconds >= 15) {
                    this.stopRecording();
                }
            }, 1000);
        } catch (err) {
            console.error("Microphone access error:", err);
            alert("Could not access microphone: " + err.message);
        }
    }

    stopRecording() {
        if (this.mediaRecorder && this.isRecording) {
            this.mediaRecorder.stop();
            this.isRecording = false;
            clearInterval(this.recordingTimer);

            if (this.el.recordBtn) {
                this.el.recordBtn.innerHTML = `
                    <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
                    <span>Record with Mic</span>
                `;
                this.el.recordBtn.classList.remove("border-red-500", "text-red-500");
            }
        }
    }

    async processVoiceFile(file) {
        if (!file.type.startsWith("audio/") && !file.name.match(/\.(wav|mp3|m4a|ogg|webm|flac)$/i)) {
            alert("Please select a valid audio file (.wav, .mp3, .m4a, .ogg).");
            return;
        }
        await this.processVoiceAudioBlob(file, file.name);
    }

    async processVoiceAudioBlob(blob, name) {
        try {
            if (this.el.voiceFileName) {
                this.el.voiceFileName.textContent = `Processing ${name}…`;
            }

            const arrayBuffer = await blob.arrayBuffer();
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);

            // Resample to 24000Hz mono Float32Array
            const resampledAudio = await resampleTo24kMono(decodedBuffer);
            this.clonedVoiceData = resampledAudio;

            // Setup preview player
            const previewBlob = encodeWAV(resampledAudio, SAMPLE_RATE);
            if (this.clonedVoiceAudioUrl) URL.revokeObjectURL(this.clonedVoiceAudioUrl);
            this.clonedVoiceAudioUrl = URL.createObjectURL(previewBlob);

            if (this.el.voicePreviewAudio) {
                this.el.voicePreviewAudio.src = this.clonedVoiceAudioUrl;
            }
            if (this.el.voicePreviewPlayer) {
                this.el.voicePreviewPlayer.classList.remove("hidden");
            }
            if (this.el.voiceFileName) {
                this.el.voiceFileName.textContent = `${name} (${(resampledAudio.length / SAMPLE_RATE).toFixed(1)}s sample ready)`;
            }

            // Encode speaker latent via Kyutai Mimi encoder in Web Worker
            this.updateStatus("Cloning voice with Mimi encoder…", "loading");
            this.worker.postMessage({
                type: "encode_voice",
                data: { audio: resampledAudio }
            });
        } catch (err) {
            console.error("Audio processing error:", err);
            alert("Could not process audio sample: " + err.message);
            if (this.el.voiceFileName) {
                this.el.voiceFileName.textContent = "Error processing audio sample.";
            }
        }
    }

    handleVoiceClonedSuccess() {
        this.currentVoice = "custom";
        if (this.el.cloneStatusBadge) {
            this.el.cloneStatusBadge.innerHTML = `
                <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
                    <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5"></span>
                    Voice Cloned & Ready (100% on-device)
                </span>
            `;
        }
        if (this.el.voiceSelect) {
            let customOpt = this.el.voiceSelect.querySelector('option[value="custom"]');
            if (!customOpt) {
                customOpt = document.createElement("option");
                customOpt.value = "custom";
                customOpt.textContent = "Custom Cloned Voice";
                this.el.voiceSelect.appendChild(customOpt);
            }
            this.el.voiceSelect.value = "custom";
        }
        this.updateStatus("Voice cloned successfully!", "idle");
    }

    setButtonState(state, text) {
        if (!this.el.generateBtn) return;
        if (state === "loading" || state === "generating") {
            this.el.generateBtn.disabled = true;
            if (this.el.btnLoader) this.el.btnLoader.classList.remove("hidden");
        } else {
            this.el.generateBtn.disabled = false;
            if (this.el.btnLoader) this.el.btnLoader.classList.add("hidden");
        }
        if (this.el.btnText) {
            this.el.btnText.textContent = text;
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

        const render = () => {
            this.animFrameId = requestAnimationFrame(render);
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            if (this.analyser && this.isGenerating) {
                this.analyser.getByteFrequencyData(dataArray);

                const barWidth = (canvas.width / bufferLength) * 1.5;
                let x = 0;

                for (let i = 0; i < bufferLength; i++) {
                    const barHeight = (dataArray[i] / 255) * canvas.height * 0.9;
                    ctx.fillStyle = `rgba(23, 23, 23, ${0.2 + (dataArray[i] / 255) * 0.8})`;

                    ctx.fillRect(x, canvas.height - barHeight, barWidth - 1, barHeight);
                    x += barWidth;
                }
            } else {
                // Subtle idle pulse line
                ctx.beginPath();
                ctx.strokeStyle = "rgba(0, 0, 0, 0.06)";
                ctx.lineWidth = 1;
                ctx.moveTo(0, canvas.height / 2);
                ctx.lineTo(canvas.width, canvas.height / 2);
                ctx.stroke();
            }
        };
        render();
    }

    async checkCacheSize() {
        if (!("caches" in window)) return;
        try {
            const cache = await caches.open("pocket-tts-models-v1");
            const keys = await cache.keys();
            if (this.el.cacheStatusBadge) {
                if (keys.length > 0) {
                    this.el.cacheStatusBadge.textContent = `${keys.length} model assets cached locally (Offline Ready)`;
                    this.el.cacheStatusBadge.className = "inline-flex items-center text-xs text-emerald-600 font-medium";
                } else {
                    this.el.cacheStatusBadge.textContent = "Model will be cached after first download.";
                }
            }
        } catch (e) {
            console.warn("Cache check error:", e);
        }
    }

    async handleClearCache() {
        if (!confirm("Clear all locally cached Pocket TTS models (~110MB)? The model will be re-downloaded next time you synthesize speech.")) return;
        if (this.worker) {
            this.worker.postMessage({ type: "clear_cache" });
        }
        if (this.el.cacheStatusBadge) {
            this.el.cacheStatusBadge.textContent = "Cache cleared. Models will download on next run.";
        }
    }
}

// Auto-initialize when DOM is ready
if (typeof window !== "undefined") {
    window.addEventListener("DOMContentLoaded", () => {
        window.pocketTTS = new PocketTTSClient();
    });
}
