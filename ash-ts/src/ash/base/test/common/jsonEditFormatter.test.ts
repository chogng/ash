import assert from 'node:assert/strict';
import { test } from 'mocha';
import { applyEdits, removeProperty, setProperty } from '../../common/jsonEdit.js';
import { format } from '../../common/jsonFormatter.js';
import { parseJsonc } from '../../common/jsonc.js';

test('JSON formatter returns source edits with VS Code compatible formatting options', () => {
	const source = '{"editor":{"enabled":true,// note\n},}';
	const edits = format(source, undefined, { tabSize: 2, insertSpaces: true });
	const formatted = applyEdits(source, edits);
	assert.match(formatted, /\n  "editor": \{/u);
	assert.match(formatted, /\/\/ note/u);
	assert.deepEqual(parseJsonc(formatted, 'formatted JSONC'), { editor: { enabled: true } });
});

test('JSON edits update nested properties and preserve JSONC comments', () => {
	const source = '{\n\t"editor": {\n\t\t// keep this note\n\t\t"enabled": true,\n\t},\n}\n';
	const formatting = { tabSize: 2, insertSpaces: true };
	const updated = applyEdits(source, setProperty(source, ['editor', 'enabled'], false, formatting));
	const inserted = applyEdits(updated, setProperty(updated, ['editor', 'fontSize'], 14, formatting));
	const removed = applyEdits(inserted, removeProperty(inserted, ['editor', 'enabled'], formatting));

	assert.match(updated, /"enabled": false/u);
	assert.match(inserted, /"fontSize": 14/u);
	assert.match(removed, /keep this note/u);
	assert.doesNotMatch(removed, /"enabled"/u);
	assert.deepEqual(parseJsonc(removed, 'edited JSONC'), { editor: { fontSize: 14 } });
});
