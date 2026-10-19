import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { controlName } from '../public/analytics.js';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
function htmlFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? htmlFiles(path) : entry.name.endsWith('.html') ? [path] : [];
    });
}

test('every built page control and accordion has a safe analytics identity', { skip: !existsSync(join(root, 'index.html')) }, () => {
    const uncovered = [];
    for (const path of htmlFiles(root)) {
        const html = readFileSync(path, 'utf8');
        for (const match of html.matchAll(/<(button|a|input|textarea|select|details)\b([^>]*)>/g)) {
            const [, tag, markup] = match;
            const attrs = Object.fromEntries([...markup.matchAll(/([\w-]+)="([^"]*)"/g)].map(attribute => [attribute[1], attribute[2]]));
            if (tag === 'details') {
                const id = attrs['data-analytics-accordion'] || '';
                const valid = id.match(/^(faq|guide)_(\d+)$/);
                assert.ok(valid && Number(valid[2]) <= (valid[1] === 'faq' ? 32 : 8), `${path}: accordion ${id} is not tracked`);
                continue;
            }
            if (tag === 'input' && attrs.type === 'hidden') continue;
            const element = {
                id: attrs.id || '', getAttribute: key => attrs[key] || null,
                matches: selector => selector === 'a' ? tag === 'a' : selector.startsWith('.') && (attrs.class || '').split(/\s+/).includes(selector.slice(1)),
            };
            if (!controlName(element)) uncovered.push(`${path}: ${tag} ${attrs.id || attrs.href || attrs.class || ''}`);
        }
    }
    assert.deepEqual(uncovered, []);
});
