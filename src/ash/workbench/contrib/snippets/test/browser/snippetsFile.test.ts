import assert from 'node:assert/strict';
import { test } from 'mocha';
import { toExtensionResourceURI } from '../../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import type { ExtensionSnippetFile } from '../../../../services/extensions/common/extensionService.js';
import { SnippetFile } from '../../browser/snippetsFile.js';

function resource(content: string): ExtensionSnippetFile {
	return {
		content,
		extensionId: 'ash.demo',
		languageIds: ['typescript', 'javascript'],
		location: toExtensionResourceURI({ generation: 1, extensionId: 'ash.demo', path: 'snippets/demo.json' }),
	};
}

test('snippet files parse JSONC, multiline bodies and descriptions, scopes and absent prefixes', () => {
	const file = new SnippetFile(
		resource(`{
		// User content is retained without resolving editor-context variables.
		"Loop": { "prefix": ["for", "loop"], "body": ["for ($1) {", "  $TM_FILENAME$0", "}"], "scope": "typescript, javascript", "description": ["Loop", "Block"], },
		"Template": { "body": "class \u0024{1:Name} {}", "isFileTemplate": true },
	}`),
	);
	assert.deepEqual(
		file.data.map(snippet => ({
			name: snippet.name,
			prefix: snippet.prefix,
			body: snippet.body,
			description: snippet.description,
			scopes: snippet.scopes,
			isFileTemplate: snippet.isFileTemplate,
		})),
		[
			{
				name: 'Loop',
				prefix: 'for',
				body: 'for ($1) {\n  $TM_FILENAME$0\n}',
				description: 'Loop\nBlock',
				scopes: ['typescript', 'javascript'],
				isFileTemplate: false,
			},
			{
				name: 'Loop',
				prefix: 'loop',
				body: 'for ($1) {\n  $TM_FILENAME$0\n}',
				description: 'Loop\nBlock',
				scopes: ['typescript', 'javascript'],
				isFileTemplate: false,
			},
			{
				name: 'Template',
				prefix: '',
				body: 'class ${1:Name} {}',
				description: '',
				scopes: ['typescript', 'javascript'],
				isFileTemplate: true,
			},
		],
	);
	assert.equal(Object.isFrozen(file.data), true);
	assert.equal(Object.isFrozen(file.data[0]), true);
	assert.equal(Object.isFrozen(file.data[0].scopes), true);
});

for (const contents of [
	'[]',
	'{"Bad":{"body":4}}',
	'{"Bad":{"body":"x","prefix":4}}',
	'{"Bad":{"body":"x","scope":4}}',
	'{"Bad":{"body":"x","isFileTemplate":"true"}}',
]) {
	test(`snippet files reject invalid resource content: ${contents}`, () => {
		assert.throws(() => new SnippetFile(resource(contents)), /Extension 'ash.demo' snippet file/);
	});
}
