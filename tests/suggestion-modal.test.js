import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const component = readFileSync(new URL('../src/components/BetaSuggestionModal.astro', import.meta.url), 'utf8');
const script = component.match(/<script is:inline>([\s\S]*?)<\/script>/)[1];

function feedbackPage() {
    let now = 0;
    const tasks = [];
    const storage = new Map();
    const events = {};
    const opened = [];
    const audio = { paused: true, ended: false };
    const document = {
        hidden: false, activeElement: null, body: { style: {} },
        getElementById: () => null,
        querySelectorAll: selector => selector === 'audio' ? [audio] : [],
        addEventListener: (name, callback) => { events[name] = callback; },
    };
    const window = { addEventListener() {}, pocketTTS: { isWorkerReady: true } };
    vm.runInNewContext(script, {
        document, window,
        Date: class extends Date { static now() { return now; } },
        sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
        setTimeout: (callback, delay) => tasks.push({ callback, at: now + delay }),
    });
    const open = window.openSuggestionModal;
    window.openSuggestionModal = options => { opened.push(options); open(options); };
    function tick(ms) {
        const end = now + ms;
        while (true) {
            tasks.sort((a, b) => a.at - b.at);
            if (!tasks.length || tasks[0].at > end) break;
            const task = tasks.shift();
            now = task.at;
            task.callback();
        }
        now = end;
    }
    return { tick, events, document, window, storage, opened, audio };
}

test('automatic feedback waits two minutes and only appears once per session', () => {
    const page = feedbackPage();
    page.tick(119_999);
    assert.equal(page.opened.length, 0);
    page.tick(1);
    assert.equal(page.opened.length, 1);
    assert.equal(page.storage.get('voco_suggestion_shown'), 'true');
    page.tick(300_000);
    assert.equal(page.opened.length, 1);
});

for (const activity of ['loading', 'generating', 'recording', 'listening', 'typing', 'hidden']) {
    test(`automatic feedback defers while ${activity} and for 30 seconds afterward`, () => {
        const page = feedbackPage();
        const studio = page.window.pocketTTS;
        if (activity === 'loading') studio.isWorkerReady = false;
        if (activity === 'generating') studio.isGenerating = true;
        if (activity === 'recording') studio.isRecording = true;
        if (activity === 'listening') page.audio.paused = false;
        if (activity === 'typing') page.document.activeElement = { matches: () => true };
        if (activity === 'hidden') page.document.hidden = true;
        page.tick(120_000);
        assert.equal(page.opened.length, 0);
        studio.isWorkerReady = true;
        studio.isGenerating = studio.isRecording = false;
        page.audio.paused = true;
        page.document.activeElement = null;
        page.document.hidden = false;
        page.tick(29_999);
        assert.equal(page.opened.length, 0);
        page.tick(1);
        assert.equal(page.opened.length, 1);
    });
}

test('recent interaction postpones feedback and dismissed feedback stays dismissed', () => {
    const page = feedbackPage();
    page.tick(119_000);
    page.events.pointerdown();
    page.tick(29_000);
    assert.equal(page.opened.length, 0);
    page.storage.set('voco_suggestion_dismissed', '1');
    page.tick(60_000);
    assert.equal(page.opened.length, 0);
});
