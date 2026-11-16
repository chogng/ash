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

test('embedded raster images agree across native and WASM and active data stays inert', () => {
    const source = '![Raster](data:image/png;base64,AQID) ![Active](data:image/svg+xml;base64,AQID) [Link](data:image/png;base64,AQID)';
    const result = spawnSync(native, { input: JSON.stringify({ source, transactions: [] }), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const document = new ArkdownDocument(source);
    try {
        const html = document.renderHtml();
        assert.equal(html, JSON.parse(result.stdout).html);
        assert.ok(html.includes('src="data:image/png;base64,AQID"'));
        assert.ok(!html.includes('image/svg+xml'));
        assert.ok(!html.includes('href='));
    } finally { document.free(); }
});

test('native and WASM agree on inline document marks and Unicode list indentation', () => {
    const source = '## 中文🙂\r\n\r\n<span data-text-color="purple"><u><mark>Text **bold**</mark></u></span>\r\n\r\n<span data-comment-id="33333333-3333-4333-8333-333333333333">Comment **anchor**</span>\r\n\r\n- Parent\r\n- Child\r\n';
    const offset = source.indexOf('Child');
    const edits = JSON.parse(markdownOperationEditsJson(source, JSON.stringify({ kind: 'indent_list', offset, end: offset, direction: 'increase' })));
    const input = { source, transactions: [{ expected_revision: 0, edits }] };
    const result = spawnSync(native, { input: JSON.stringify(input), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const document = new ArkdownDocument(source);
    try {
        const changes = input.transactions.map(value => JSON.parse(document.applyTransactionJson(JSON.stringify(value))));
        assert.deepEqual({ snapshot: JSON.parse(document.snapshotJson()), html: document.renderHtml(), changes }, JSON.parse(result.stdout));
        assert.ok(document.source.includes('  - Child'));
        assert.ok(document.renderHtml().includes('<u><mark>Text <strong>bold</strong></mark></u>'));
    } finally { document.free(); }
});

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

test('table actions retain metadata, merged source cells and shared undo across WASM', () => {
    const source = '前言🙂\r\n\r\n| 名称 | 数量 |\r\n| --- | --- |\r\n| 甲 | 2 |\r\n| 乙 | 1 |\r\n\r\n后记\r\n';
    const document = new ArkdownDocument(source);
    const offset = source.indexOf('|');
    const action = action => {
        const edits = JSON.parse(markdownOperationEditsJson(document.source, JSON.stringify({ kind: 'table', offset, action })));
        document.applyTransactionJson(JSON.stringify({ expected_revision: document.revision, edits }));
    };
    try {
        action({ kind: 'set_column_width', column: 0, width: 224 });
        action({ kind: 'sort_column', column: 1, direction: 'ascending' });
        action({ kind: 'merge_cells', top: 1, left: 0, bottom: 1, right: 1 });
        action({ kind: 'set_cell_color', top: 1, left: 0, bottom: 1, right: 1, color: 'blue' });
        const table = JSON.parse(parseMarkdownJson(document.source)).find(node => node.kind === 'table');
        assert.deepEqual(table.layout.widths, [224, 0]);
        assert.deepEqual(table.layout.cells, [{ row: 1, column: 0, rowspan: 1, colspan: 2, color: 'blue' }]);
        assert.equal(table.children[1].children.length, 2);
        assert.ok(document.source.startsWith('前言🙂\r\n\r\n'));
        assert.ok(document.source.endsWith('\r\n\r\n后记\r\n'));
        assert.ok(document.renderHtml().includes('colspan="2"'));
        assert.ok(!document.renderHtml().includes('ash-table'));
        for (let index = 0; index < 4; index++) document.undo(document.revision);
        assert.equal(document.source, source);
        for (const invalid of [
            { kind: 'set_column_width', column: 0, width: 47 },
            { kind: 'insert_column', index: -1 },
            { kind: 'merge_cells', top: 0, left: 0, bottom: 0.5, right: 1 },
            { kind: 'set_cell_color', top: 0, left: 0, bottom: 0, right: 0, color: 'url(bad)' },
            { kind: 'delete_table', unknown: true },
        ]) assert.throws(() => markdownOperationEditsJson(document.source, JSON.stringify({ kind: 'table', offset, action: invalid })), rejects('invalid_request'));
        assert.equal(document.source, source);
    } finally { document.free(); }
});

test('native and WASM agree on complete table layout and safe HTML export', () => {
    const source = '| a | b |\n| --- | --- |\n| c | d |\n\n<!-- ash-table {"widths":[112,224],"header":false,"cells":[{"row":0,"column":0,"rowspan":2,"colspan":1,"color":"red"}]} -->\n';
    const input = { source, transactions: [] };
    const result = spawnSync(native, { input: JSON.stringify(input), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const document = new ArkdownDocument(source);
    try {
        assert.deepEqual({ snapshot: JSON.parse(document.snapshotJson()), html: document.renderHtml(), changes: [] }, JSON.parse(result.stdout));
    } finally { document.free(); }
});

test('WASM table range widths commit once and short rows expose safe virtual cell targets', () => {
    const source = '| a | b | c |\r\n| --- | --- | --- |\r\n| one |\r\n| two | three |\r\n';
    const nodes = JSON.parse(parseMarkdownJson(source));
    const row = nodes[0].children[1];
    assert.equal(row.children.length, 3);
    assert.equal(row.children[2].missing, true);
    assert.equal(row.children[2].source.utf16.start, row.source.utf16.end - 2);
    const document = new ArkdownDocument(source);
    try {
        const edits = JSON.parse(markdownOperationEditsJson(source, JSON.stringify({ kind: 'table', offset: 0, action: { kind: 'set_column_width', column: 0, end_column: 1, width: 336 } })));
        assert.equal(edits.length, 1);
        document.applyTransactionJson(JSON.stringify({ expected_revision: 0, edits }));
        assert.deepEqual(JSON.parse(parseMarkdownJson(document.source))[0].layout.widths, [336, 336, 0]);
        document.undo(document.revision);
        assert.equal(document.source, source);
        assert.throws(() => markdownOperationEditsJson(source, JSON.stringify({ kind: 'table', offset: 0, action: { kind: 'set_column_width', column: 1, end_column: 0, width: 336 } })), rejects('invalid_request'));
    } finally { document.free(); }
});

test('WASM table clipboard fragments validate relative spans and retain multiline cell text', () => {
    const source = '| a | b |\n| --- | --- |\n| c | d |\n';
    const action = { kind: 'paste_cells', row: 1, column: 0, values: [['one\r\ntwo', '']], cells: [{ row: 0, column: 0, rowspan: 1, colspan: 2, color: 'purple' }] };
    const document = new ArkdownDocument(source);
    try {
        const edits = JSON.parse(markdownOperationEditsJson(source, JSON.stringify({ kind: 'table', offset: 0, action })));
        document.applyTransactionJson(JSON.stringify({ expected_revision: 0, edits }));
        assert.ok(document.source.includes('one&#10;two'));
        const table = JSON.parse(parseMarkdownJson(document.source))[0];
        assert.deepEqual(table.layout.cells, [{ row: 1, column: 0, rowspan: 1, colspan: 2, color: 'purple' }]);
        assert.ok(document.renderHtml().includes('one\ntwo'));
        assert.throws(() => markdownOperationEditsJson(source, JSON.stringify({ kind: 'table', offset: 0, action: { ...action, cells: [{ ...action.cells[0], colspan: 3 }] } })), rejects('invalid_request'));
        document.undo(document.revision);
        assert.equal(document.source, source);
    } finally { document.free(); }
});

test('WASM table sorting keeps blanks last and selects one numeric mode for the whole column', () => {
    const sorted = (keys, direction) => {
        const source = '| Key | Row |\n| --- | --- |\n' + keys.map((key, index) => `| ${key} | ${index} |\n`).join('');
        const edits = JSON.parse(markdownOperationEditsJson(source, JSON.stringify({ kind: 'table', offset: 0, action: { kind: 'sort_column', column: 0, direction } })));
        const document = new ArkdownDocument(source);
        try {
            document.applyTransactionJson(JSON.stringify({ expected_revision: 0, edits }));
            return JSON.parse(parseMarkdownJson(document.source))[0].children.slice(1).map(row => Number(row.children[1].children.map(node => node.text ?? '').join('')));
        } finally { document.free(); }
    };
    assert.deepEqual(sorted(['', '2', '10', '', '2'], 'ascending'), [1, 4, 2, 0, 3]);
    assert.deepEqual(sorted(['', '2', '10', '', '2'], 'descending'), [2, 1, 4, 0, 3]);
    const numeric = ['$1,200.50', '€50', '10%', '£-3', '1,200.5', '**50**', ''];
    assert.deepEqual(sorted(numeric, 'ascending'), [3, 2, 1, 5, 0, 4, 6]);
    assert.deepEqual(sorted(numeric, 'descending'), [0, 4, 1, 5, 2, 3, 6]);
    const mixed = ['10 apples', '3', '2 apples', 'ITEM10', 'item2', '', '12,34'];
    assert.deepEqual(sorted(mixed, 'ascending'), [2, 1, 0, 6, 4, 3, 5]);
    assert.deepEqual(sorted(mixed, 'descending'), [3, 4, 6, 0, 1, 2, 5]);
    assert.deepEqual(sorted(['Item2', 'item02', 'ITEM2', 'café2', 'Cafe2', 'Item10', ''], 'descending'), [5, 0, 1, 2, 3, 4, 6]);
});
