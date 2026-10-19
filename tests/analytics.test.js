import assert from 'node:assert/strict';
import test from 'node:test';
import { trackEvent, configureAnalytics, initAnalytics, voiceAnalytics, errorCategory, controlName } from '../public/analytics.js';
import { PocketTTSClient, VoiceStorage } from '../public/pocket-client.js';

function browser() {
    const previous = { window: globalThis.window, document: globalThis.document };
    const calls = [];
    const handlers = {};
    globalThis.window = {
        location: { hostname: 'www.vocospeech.xyz', origin: 'https://www.vocospeech.xyz', pathname: '/', search: '?text=private', hash: '#private' },
        navigator: {}, gtag: (...args) => calls.push(args), addEventListener() {},
    };
    globalThis.document = {
        referrer: 'https://example.com/private-person?email=private@example.com',
        addEventListener: (name, handler) => { handlers[name] = handler; }, querySelectorAll: () => [],
    };
    return { calls, handlers, restore() { Object.assign(globalThis, previous); } };
}

test('analytics excludes private content, arbitrary parameters, custom names, and URL details', () => {
    const page = browser();
    try {
        trackEvent('generation_requested', {
            text: 'Private speech', voice_name: 'Alice', voice_id: 'voice_123',
            builtin_voice: 'Alice', voice_type: 'custom', language: 'english_2026-04',
            character_range: '1_100', error: 'Private error message', audio: new Float32Array(100),
        });
        const payload = page.calls[0][2];
        assert.deepEqual(payload, {
            page_path: '/', page_location: 'https://www.vocospeech.xyz/', page_referrer: 'https://example.com/',
            voice_type: 'custom', language: 'english_2026-04', character_range: '1_100',
        });
        window.location.pathname = '/private@example.com';
        trackEvent('clone_ready');
        assert.equal(page.calls[1][2].page_path, '/other');
        assert.equal(JSON.stringify(page.calls).includes('private'), false);
        assert.deepEqual(voiceAnalytics('voice_private_name'), { voice_type: 'custom' });
    } finally { page.restore(); }
});

test('analytics honors privacy opt-outs and excludes local traffic', () => {
    const page = browser();
    try {
        window.navigator.globalPrivacyControl = true;
        trackEvent('clone_ready');
        window.navigator.globalPrivacyControl = false;
        window.navigator.doNotTrack = '1';
        trackEvent('clone_ready');
        window.navigator.doNotTrack = '0';
        window.location.hostname = 'localhost';
        trackEvent('clone_ready');
        window.location.hostname = 'www.vocospeech.xyz';
        window['ga-disable-G-FJ0X98RSJ8'] = true;
        trackEvent('clone_ready');
        assert.equal(page.calls.length, 0);
    } finally { page.restore(); }
});

test('Google bootstrap sanitizes automatic page views and disables advertising features', () => {
    const page = browser();
    try {
        configureAnalytics();
        const config = page.calls.find(call => call[0] === 'config')[2];
        assert.equal(config.page_location, 'https://www.vocospeech.xyz/');
        assert.equal(config.page_referrer, 'https://example.com/');
        assert.equal(config.allow_google_signals, false);
        assert.equal(config.allow_ad_personalization_signals, false);
    } finally { page.restore(); }
});

test('analytics failure cannot break application actions', () => {
    const page = browser();
    try {
        window.gtag = () => { throw new Error('Blocked'); };
        assert.doesNotThrow(() => trackEvent('clone_ready'));
        assert.doesNotThrow(() => configureAnalytics());
        delete window.gtag;
        assert.doesNotThrow(() => trackEvent('clone_ready'));
        assert.equal(errorCategory(new Error('Voice sample encoding failed (202583232)')), 'encoder');
        assert.equal(errorCategory({ name: 'NotAllowedError' }), 'permission_denied');
    } finally { page.restore(); }
});

function control(id, value = '') {
    return {
        id, value, disabled: false,
        getAttribute: () => null,
        matches: selector => selector === 'input, textarea, select' && id === 'text-input',
        closest(selector) { return selector === '#workbench' ? {} : selector === 'button, a, input[type="radio"]' ? this : null; },
    };
}

test('delegated listeners cover clicks, one-time field starts, and content-free changes', () => {
    const page = browser();
    try {
        initAnalytics();
        page.handlers.click({ target: control('generate-btn') });
        const text = control('text-input', 'An entirely private script');
        page.handlers.focusin({ target: text });
        page.handlers.focusin({ target: text });
        page.handlers.change({ target: text });
        page.handlers.change({ target: control('voice-select', 'voice_personal_name') });
        assert.deepEqual(page.calls.map(call => call[1]), ['control_click', 'field_started', 'control_change', 'control_change']);
        assert.equal(page.calls[0][2].control, 'generate_btn');
        assert.equal(page.calls[2][2].character_range, '1_100');
        assert.equal(page.calls[3][2].selection, 'custom');
        assert.equal(JSON.stringify(page.calls).includes('private'), false);
        assert.equal(JSON.stringify(page.calls).includes('personal_name'), false);
    } finally { page.restore(); }
});

test('dynamic voice controls never derive labels from voice content', () => {
    const element = { id: 'voice_private', getAttribute: () => null, matches: selector => selector === '.delete-voice-btn' };
    assert.equal(controlName(element), 'saved_voice_delete');
});

test('the studio emits a complete generation funnel without the script or cloned voice name', async () => {
    const page = browser();
    const originalWorker = globalThis.Worker;
    const getVoice = VoiceStorage.getVoice;
    const client = Object.create(PocketTTSClient.prototype);
    globalThis.Worker = class { postMessage() {} terminate() {} };
    VoiceStorage.getVoice = async () => ({ id: 'voice_private_id', name: 'Private person', audioData: [0.1] });
    Object.assign(client, { el: {}, currentLanguage: 'english_2026-04', currentSampleRate: 24000 });
    try {
        client.initWorker();
        await client.worker.onmessage({ data: { type: 'bundle_loaded', language: 'english_2026-04' } });
        await client.startActualGeneration('A private script', 'voice_private_id', 0.7);
        await client.worker.onmessage({ data: { type: 'generation_started' } });
        await client.worker.onmessage({ data: { type: 'audio_chunk', data: new Float32Array(24000), metrics: {} } });
        await client.worker.onmessage({ data: { type: 'stream_ended' } });
        assert.deepEqual(page.calls.map(call => call[1]), [
            'engine_load_started', 'engine_ready', 'generation_requested', 'generation_started', 'generation_first_audio', 'generation_completed',
        ]);
        assert.equal(page.calls.at(-1)[2].voice_type, 'custom');
        assert.equal(page.calls.at(-1)[2].duration_s, 1);
        assert.equal(JSON.stringify(page.calls).toLowerCase().includes('private'), false);
    } finally {
        if (client.lastCompletedAudioUrl) URL.revokeObjectURL(client.lastCompletedAudioUrl);
        globalThis.Worker = originalWorker;
        VoiceStorage.getVoice = getVoice;
        page.restore();
    }
});
