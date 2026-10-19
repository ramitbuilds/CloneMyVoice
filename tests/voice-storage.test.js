import assert from 'node:assert/strict';
import test from 'node:test';
import { VoiceStorage } from '../public/pocket-client.js';

for (const operation of ['save', 'delete']) {
    test(`${operation} waits for the storage transaction to commit and rejects an abort`, async () => {
        const open = VoiceStorage.openDB;
        let closed = 0;
        let transaction;
        const request = { result: 'voice_test' };
        VoiceStorage.openDB = async () => ({
            close() { closed++; },
            transaction() {
                transaction = { objectStore: () => ({ put: () => request, delete: () => request }) };
                return transaction;
            },
        });
        try {
            let settled = false;
            const pending = operation === 'save' ? VoiceStorage.saveVoice({ id: 'voice_test' }) : VoiceStorage.deleteVoice('voice_test');
            pending.then(() => { settled = true; }, () => { settled = true; });
            await Promise.resolve();
            await Promise.resolve();
            assert.equal(settled, false);
            assert.equal(closed, 0);
            transaction.oncomplete();
            await pending;
            assert.equal(closed, 1);
            const aborted = operation === 'save' ? VoiceStorage.saveVoice({ id: 'voice_test' }) : VoiceStorage.deleteVoice('voice_test');
            await Promise.resolve();
            transaction.error = new Error('Quota exceeded');
            transaction.onabort();
            await assert.rejects(aborted, /Quota exceeded/);
            assert.equal(closed, 2);
        } finally { VoiceStorage.openDB = open; }
    });
}
