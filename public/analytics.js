const MEASUREMENT_ID = 'G-FJ0X98RSJ8';
const ROUTES = new Set(['/', '/about', '/about-us', '/contact', '/contact-us', '/privacy', '/privacy-policy', '/terms', '/terms-and-conditions', '/404', '/500']);
const LANGUAGES = ['english_2026-04', 'german', 'italian', 'portuguese', 'spanish'];
const BUILTIN_VOICES = ['alba', 'azelma', 'cosette', 'eponine', 'fantine', 'javert', 'jean', 'marius'];
const SECTIONS = ['navigation', 'hero', 'workbench', 'features', 'guide', 'faq', 'feedback', 'footer', 'page'];
const IDS = ['tab-tts', 'tab-clone', 'shortcut-clone-voice', 'retry-engine-btn', 'generate-btn', 'stop-btn', 'record-btn', 're-record-btn', 'save-clone-btn', 'clone-success-cta', 'download-audio-btn', 'clear-cache-btn', 'theme-toggle-btn', 'mobile-menu-btn', 'open-suggestion-modal-btn', 'nav-suggestion-btn', 'close-suggestion-modal-btn', 'skip-suggestion-btn', 'submit-suggestion-btn', 'close-success-btn', 'copy-email-btn', 'language-select', 'voice-select', 'temperature-slider', 'text-input', 'clone-voice-name', 'suggestion-text', 'suggestion-author-name', 'attrib-credited-radio', 'attrib-anon-radio'];
const LINK_TARGETS = {
    '/': 'home', '/#workbench': 'workspace', '/#features': 'features', '/#guide': 'guide', '/#faq': 'faq', '#main-content': 'skip_content',
    '/about': 'about', '/contact': 'contact', '/privacy': 'privacy', '/terms': 'terms', 'mailto:hi@vocospeech.xyz': 'email',
    'mailto:hi@vocospeech.xyz?subject=500%20Error%20Report': 'error_report_email',
};
const TOPICS = { 'Voice Quality': 'voice_quality', 'New Voices': 'voices_accents', 'Voice Cloning': 'voice_cloning', 'New Feature': 'new_feature', 'Speed / Performance': 'speed_performance' };
const CONTROLS = new Set([
    ...IDS.map(id => id.replaceAll('-', '_')), ...Object.values(LINK_TARGETS).map(id => `link_${id}`),
    'saved_voice_use', 'saved_voice_delete', 'sample_welcome', 'sample_support', 'sample_story', 'sample_tutorial',
    ...Object.values(TOPICS).map(id => `feedback_topic_${id}`),
    ...Array.from({ length: 32 }, (_, i) => `faq_${i + 1}`), ...Array.from({ length: 8 }, (_, i) => `guide_${i + 1}`),
]);
const COMMON = {
    language: LANGUAGES, voice_type: ['builtin', 'custom', 'unknown'], builtin_voice: BUILTIN_VOICES,
    duration_s: 'number', elapsed_ms: 'number', latency_ms: 'number', tone: 'number',
    character_range: ['empty', '1_100', '101_500', '501_2000', '2001_plus'],
    error_category: ['permission_denied', 'microphone_unavailable', 'storage', 'network', 'memory', 'encoder', 'engine', 'unknown'],
    stage: ['recording', 'processing', 'storage', 'encoding'],
};
const SCHEMAS = {
    control_click: { control: CONTROLS, section: SECTIONS },
    field_started: { control: CONTROLS, section: SECTIONS },
    control_change: { control: CONTROLS, selection: [...LANGUAGES, ...BUILTIN_VOICES, 'custom', 'credited', 'anonymous'], character_range: COMMON.character_range, tone: 'number', has_value: 'boolean' },
    section_view: { section: SECTIONS }, page_scroll: { percent: [25, 50, 75, 100] },
    accordion_toggle: { control: CONTROLS, expanded: 'boolean' },
    media_action: { media: ['generated', 'recording_preview', 'saved_voice_preview'], action: ['play', 'pause', 'ended', 'seeked', 'volumechange', 'ratechange'] },
    theme_changed: { selection: ['dark', 'light'] },
    engine_load_started: { language: LANGUAGES, isolated: 'boolean' },
    engine_ready: { language: LANGUAGES, elapsed_ms: 'number', cache_source: ['cache', 'network'], isolated: 'boolean' },
    engine_failed: { error_category: COMMON.error_category, language: LANGUAGES },
    generation_requested: COMMON, generation_started: COMMON, generation_first_audio: { latency_ms: 'number' },
    generation_completed: COMMON, generation_failed: COMMON, generation_stopped: COMMON,
    generation_validation_error: { reason: ['empty_text', 'engine_not_ready'] },
    clone_recording_requested: {}, clone_recording_started: {}, clone_recording_stopped: { duration_s: 'number' },
    clone_sample_ready: { duration_s: 'number' }, clone_saved: { duration_s: 'number' }, clone_ready: {}, clone_failed: COMMON,
    voice_selected: { voice_type: COMMON.voice_type, builtin_voice: BUILTIN_VOICES }, voice_deleted: {},
    download_requested: { voice_type: COMMON.voice_type, duration_s: 'number' }, cache_cleared: {},
    feedback_opened: { source: ['manual', 'idle_usage'] }, feedback_closed: {},
    feedback_validation_error: { field: ['suggestion', 'attribution'] },
    feedback_submitted: { topic: [...Object.values(TOPICS), 'none'], attribution: ['credited', 'anonymous'] },
    feedback_delivery_failed: {},
};

export function pagePath(pathname) {
    const path = pathname.replace(/\/$/, '') || '/';
    return ROUTES.has(path) ? path : '/other';
}

function pageContext() {
    const path = pagePath(window.location.pathname);
    let referrer = '';
    try { referrer = document.referrer ? new URL(document.referrer).origin + '/' : ''; } catch {}
    return { page_path: path, page_location: window.location.origin + path, page_referrer: referrer };
}

export function configureAnalytics() {
    try {
        window.dataLayer = window.dataLayer || [];
        window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
        const disabled = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname) || window.navigator?.globalPrivacyControl || window.navigator?.doNotTrack === '1';
        if (disabled) window[`ga-disable-${MEASUREMENT_ID}`] = true;
        window.gtag('js', new Date());
        window.gtag('set', pageContext());
        window.gtag('config', MEASUREMENT_ID, {
            ...pageContext(), send_page_view: !window[`ga-disable-${MEASUREMENT_ID}`],
            allow_google_signals: false, allow_ad_personalization_signals: false,
        });
    } catch {
        // A blocked Google tag must not prevent the studio's modules from loading.
    }
}

export function textLengthRange(length) {
    return length <= 0 ? 'empty' : length <= 100 ? '1_100' : length <= 500 ? '101_500' : length <= 2000 ? '501_2000' : '2001_plus';
}

export function voiceAnalytics(voice) {
    if (BUILTIN_VOICES.includes(voice)) return { voice_type: 'builtin', builtin_voice: voice };
    return { voice_type: typeof voice === 'string' && voice.startsWith('voice_') ? 'custom' : 'unknown' };
}

export function errorCategory(error) {
    const message = String(error?.name || '') + ' ' + String(error);
    if (/NotAllowed|PermissionDenied/i.test(message)) return 'permission_denied';
    if (/NotFound|NotReadable|microphone/i.test(message)) return 'microphone_unavailable';
    if (/Quota|IndexedDB|storage/i.test(message)) return 'storage';
    if (/fetch|network|Timeout|HTTP/i.test(message)) return 'network';
    if (/alloc|memory|out of bounds/i.test(message)) return 'memory';
    if (/encod/i.test(message)) return 'encoder';
    if (/onnx|wasm|engine/i.test(message) || typeof error === 'number') return 'engine';
    return 'unknown';
}

// Only explicitly listed fields and bounded values can reach Google Analytics.
export function trackEvent(name, parameters = {}) {
    try {
        if (typeof window === 'undefined' || typeof window.gtag !== 'function' || !SCHEMAS[name]) return;
        if (window[`ga-disable-${MEASUREMENT_ID}`] || window.navigator?.globalPrivacyControl || window.navigator?.doNotTrack === '1') return;
        if (['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)) return;
        const safe = pageContext();
        for (const [key, rule] of Object.entries(SCHEMAS[name])) {
            const value = parameters[key];
            if (rule === 'number' && typeof value === 'number' && Number.isFinite(value) && value >= 0) safe[key] = Math.min(86_400_000, Math.round(value * 100) / 100);
            else if (rule === 'boolean' && typeof value === 'boolean') safe[key] = value;
            else if (Array.isArray(rule) && rule.includes(value)) safe[key] = value;
            else if (rule instanceof Set && rule.has(value)) safe[key] = value;
        }
        window.gtag('event', name, safe);
    } catch {
        // Analytics must never interrupt recording, storage, or speech generation.
    }
}

function sectionOf(element) {
    if (element.closest('#suggestion-modal-backdrop, aside[aria-label="Suggest a feature"]')) return 'feedback';
    if (element.closest('header')) return 'navigation';
    if (element.closest('footer')) return 'footer';
    for (const section of ['workbench', 'features', 'guide', 'faq']) if (element.closest(`#${section}`)) return section;
    return element.closest('[data-analytics-section="hero"]') ? 'hero' : 'page';
}

export function controlName(element) {
    if (IDS.includes(element.id)) return element.id.replaceAll('-', '_');
    if (element.matches('.use-voice-btn')) return 'saved_voice_use';
    if (element.matches('.delete-voice-btn')) return 'saved_voice_delete';
    const preset = element.getAttribute('data-analytics-preset');
    if (['welcome', 'support', 'story', 'tutorial'].includes(preset)) return `sample_${preset}`;
    const topic = TOPICS[element.getAttribute('data-topic')];
    if (element.matches('.topic-pill') && topic) return `feedback_topic_${topic}`;
    if (element.matches('a')) return LINK_TARGETS[element.getAttribute('href')] ? `link_${LINK_TARGETS[element.getAttribute('href')]}` : null;
    return null;
}

export function initAnalytics() {
    const startedFields = new Set();
    document.addEventListener('click', event => {
        const element = event.target.closest?.('button, a, input[type="radio"]');
        if (!element || element.disabled) return;
        const control = controlName(element);
        if (control) trackEvent('control_click', { control, section: sectionOf(element) });
    }, true);
    document.addEventListener('focusin', event => {
        const element = event.target;
        if (!element.matches('input, textarea, select') || startedFields.has(element.id)) return;
        const control = controlName(element);
        if (!control) return;
        startedFields.add(element.id);
        trackEvent('field_started', { control, section: sectionOf(element) });
    });
    document.addEventListener('change', event => {
        const element = event.target;
        const control = controlName(element);
        if (!control) return;
        const parameters = { control };
        if (element.id === 'language-select') parameters.selection = element.value;
        else if (element.id === 'voice-select') parameters.selection = BUILTIN_VOICES.includes(element.value) ? element.value : 'custom';
        else if (element.id === 'temperature-slider') parameters.tone = Number(element.value);
        else if (element.matches('input[type="radio"]')) parameters.selection = element.id === 'attrib-credited-radio' ? 'credited' : 'anonymous';
        else if (element.id === 'text-input') parameters.character_range = textLengthRange(element.value.length);
        else parameters.has_value = Boolean(element.value?.trim());
        trackEvent('control_change', parameters);
    });
    document.addEventListener('toggle', event => {
        const control = event.target.getAttribute?.('data-analytics-accordion');
        if (control) trackEvent('accordion_toggle', { control, expanded: event.target.open });
    }, true);
    for (const action of ['play', 'pause', 'ended', 'seeked', 'volumechange', 'ratechange']) {
        document.addEventListener(action, event => {
            const element = event.target;
            const media = element.id === 'audio-playback' ? 'generated' : element.id === 'voice-preview-audio' ? 'recording_preview' : element.matches?.('.saved-voice-preview') ? 'saved_voice_preview' : null;
            if (media) trackEvent('media_action', { media, action });
        }, true);
    }
    window.addEventListener('themechange', () => trackEvent('theme_changed', { selection: document.documentElement.dataset.theme }));
    if ('IntersectionObserver' in window) {
        const observer = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                trackEvent('section_view', { section: entry.target.dataset.analyticsSection });
                observer.unobserve(entry.target);
            }
        }, { threshold: 0 });
        document.querySelectorAll('[data-analytics-section]').forEach(element => observer.observe(element));
    }
    const seenDepths = new Set();
    window.addEventListener('scroll', () => {
        const height = document.documentElement.scrollHeight;
        if (height <= window.innerHeight) return;
        const percent = (window.scrollY + window.innerHeight) / height * 100;
        for (const depth of [25, 50, 75, 100]) {
            if (percent + 0.5 < depth || seenDepths.has(depth)) continue;
            seenDepths.add(depth);
            trackEvent('page_scroll', { percent: depth });
        }
    }, { passive: true });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    configureAnalytics();
    window.vocoTrack = trackEvent;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAnalytics, { once: true });
    else initAnalytics();
}
