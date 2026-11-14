import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const path = resolve(process.env.ARKDOWN_WASM_BINDINGS ?? '.build/arkdown/web/ash_arkdown.js');
const { default: init, ArkdownDocument, parseMarkdownJson, validateMarkdownEditsJson, markdownOperationEditsJson, ArkdownProjection, ArkdownBuffer } = await import(pathToFileURL(path));
await init({ module_or_path: await readFile(path.replace(/\.js$/, '_bg.wasm')) });
const native = resolve(process.env.ARKDOWN_NATIVE_EXAMPLE ?? `.build/cargo/ci-test/examples/inspect${process.platform === 'win32' ? '.exe' : ''}`);
const transaction = (revision, start, end, text) => ({ expected_revision: revision, edits: [{ range: { start, end }, text }] });
const rejects = code => error => JSON.parse(String(error)).code === code;

test('native and WASM return identical snapshots, source ranges, HTML and changes', () => {
    const input = {
        source: '# 中文🙂\r\n\r\n**original** &amp; [link](https://example.com)\r\n',
        transactions: [transaction(0, 2, 6, 'Arkdown'), transaction(1, 13, 13, 'new ')],
    };
    const result = spawnSync(native, { input: JSON.stringify(input), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const expected = JSON.parse(result.stdout);
    const document = new ArkdownDocument(input.source);
    try {
        const changes = input.transactions.map(value => JSON.parse(document.applyTransactionJson(JSON.stringify(value))));
        assert.deepEqual({ snapshot: JSON.parse(document.snapshotJson()), html: document.renderHtml(), changes }, expected);
        const source = document.source;
        assert.equal(JSON.parse(document.undo(2)).changed, true);
        assert.equal(JSON.parse(document.redo(3)).changed, true);
        assert.equal(document.source, source);
    } finally { document.free(); }
});

test('invalid transactions and stale revisions leave the WASM owner unchanged', () => {
    const document = new ArkdownDocument('a🙂b');
    try {
        assert.throws(() => document.applyTransactionJson(JSON.stringify(transaction(0, 2, 3, 'x'))), rejects('invalid_utf16_offset'));
        assert.throws(() => document.applyTransactionJson(JSON.stringify(transaction(8, 0, 0, 'x'))), rejects('revision_mismatch'));
        assert.throws(() => document.applyTransactionJson('{'), rejects('invalid_request'));
        assert.equal(document.source, 'a🙂b');
        assert.equal(document.revision, 0);
        assert.equal(document.canUndo, false);
    } finally { document.free(); }
});

test('WASM numeric boundaries reject wrapping, fractions and non-finite numbers', () => {
    const document = new ArkdownDocument('');
    try {
        for (const value of [-1, 0.5, 2 ** 32, NaN, Infinity]) {
            assert.throws(() => document.undo(value), rejects('invalid_request'));
            assert.throws(() => document.nextGrapheme(value), rejects('invalid_request'));
        }
        assert.equal(document.revision, 0);
    } finally { document.free(); }
});

test('WASM cursor movement uses grapheme boundaries and HTML stays inert', () => {
    const document = new ArkdownDocument('👩‍👩‍👧‍👦e\u0301\n\n<script>alert(1)</script>');
    try {
        assert.equal(document.nextGrapheme(0), 11);
        assert.equal(document.previousGrapheme(13), 11);
        assert.ok(document.renderHtml().includes('&lt;script&gt;'));
        assert.ok(!document.renderHtml().includes('<script>'));
    } finally { document.free(); }
});


test('Workbench projection and edit validation do not retain writable state', () => {
    const source = '# 中文🙂\r\n\r\n**bold**';
    const document = new ArkdownDocument(source);
    try {
        assert.deepEqual(JSON.parse(parseMarkdownJson(source)), JSON.parse(document.snapshotJson()).nodes);
        const edits = [{ range: { start: 2, end: 6 }, text: 'new' }];
        assert.deepEqual(JSON.parse(validateMarkdownEditsJson(source, JSON.stringify(edits))), edits);
        assert.deepEqual(JSON.parse(validateMarkdownEditsJson(source, JSON.stringify([{ range: { start: 2, end: 2 }, text: '' }]))), []);
        assert.throws(() => validateMarkdownEditsJson(source, JSON.stringify([{ range: { start: 5, end: 6 }, text: 'x' }])), rejects('invalid_utf16_offset'));
        assert.equal(document.source, source);
        assert.equal(document.canUndo, false);
    } finally { document.free(); }
});

test('structural operations cross WASM without rewriting surrounding Markdown', () => {
    const document = new ArkdownDocument('- [ ] task\r\n\r\n| a | b |\r\n| - | - |\r\n| c | d |');
    try {
        const operation = JSON.stringify({ kind: 'set_task_checked', offset: 3, checked: true });
        const edits = JSON.parse(markdownOperationEditsJson(document.source, operation));
        assert.deepEqual(edits, [{ range: { start: 3, end: 4 }, text: 'x' }]);
        document.applyOperationJson(0, operation);
        assert.ok(document.source.startsWith('- [x] task\r\n'));
        assert.throws(() => document.applyOperationJson(0, operation), rejects('revision_mismatch'));
        document.applyOperationJson(1, JSON.stringify({ kind: 'insert_table_row', offset: document.source.indexOf('| c') }));
        assert.ok(document.source.endsWith('| c | d |\r\n|   |   |\r\n'));
        document.undo(2);
        assert.ok(document.source.endsWith('| c | d |'));
    } finally { document.free(); }
});

test('CRDT WASM updates converge, replay idempotently and retain remote edits on local undo', () => {
    const first = new ArkdownBuffer(101, 'alpha🙂 beta');
    const second = new ArkdownBuffer(102, '');
    try {
        second.applyUpdate(first.encodeUpdate(new Uint8Array()));
        assert.equal(second.canUndo, false);
        first.applyTransactionJson(JSON.stringify(transaction(0, 2, 2, '甲')));
        second.applyTransactionJson(JSON.stringify(transaction(second.revision, 2, 2, '乙')));
        const left = first.encodeUpdate(second.stateVector());
        const right = second.encodeUpdate(first.stateVector());
        first.applyUpdate(right); second.applyUpdate(left);
        assert.equal(first.source, second.source);
        assert.ok(first.source.includes('甲') && first.source.includes('乙'));
        const before = first.source;
        const revision = first.revision;
        assert.equal(JSON.parse(first.applyUpdate(right)).changed, false);
        assert.equal(first.revision, revision);
        first.undo(first.revision);
        assert.ok(!first.source.includes('甲') && first.source.includes('乙'));
        second.applyUpdate(first.encodeUpdate(second.stateVector()));
        assert.equal(first.source, second.source);
        first.redo(first.revision);
        assert.equal(first.source, before);
        assert.throws(() => first.applyUpdate(new Uint8Array([255])), rejects('invalid_request'));
        assert.equal(first.source, before);
    } finally { first.free(); second.free(); }
});

test('CRDT WASM boundaries reject invalid peer IDs and partial surrogate edits', () => {
    for (const id of [0, -1, 0.5, NaN, Infinity, 2 ** 53]) {
        assert.throws(() => new ArkdownBuffer(id, ''), rejects('invalid_request'));
    }
    const doc = new ArkdownBuffer(103, '🙂');
    try {
        assert.throws(() => doc.applyTransactionJson(JSON.stringify(transaction(0, 1, 2, 'bad'))), rejects('invalid_utf16_offset'));
        assert.equal(doc.source, '🙂');
        assert.equal(doc.canUndo, false);
    } finally { doc.free(); }
});

test('read-only WASM projection matches full parsing across local and external changes', () => {
    const projection = new ArkdownProjection();
    try {
        for (const source of ['alpha beta\n\n# tail🙂', 'al中文 beta\n\n# tail🙂', '# changed\n\n- [ ] task', '[link][id]\n\n[id]: /new', '']) {
            assert.deepEqual(JSON.parse(projection.parseJson(source)), JSON.parse(parseMarkdownJson(source)));
            assert.deepEqual(JSON.parse(projection.parseJson(source)), JSON.parse(parseMarkdownJson(source)));
        }
    } finally { projection.free(); }
});
