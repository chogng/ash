import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../../../base/common/uri.js';
import { PromptFileParser } from '../../../../common/promptSyntax/promptFileParser.js';
import { PromptValidator } from '../../../../common/promptSyntax/languageProviders/promptValidator.js';
import { LanguageDiagnosticSeverity } from '../../../../../../../editor/common/languages.js';

function diagnostics(fields: string, directory = 'review') {
	return new PromptValidator().validate(new PromptFileParser().parse(URI.file(`/skills/${directory}/SKILL.md`), `---\n${fields}\n---`));
}

test('Skill draft names and descriptions match the catalog shape and Unicode character limits', () => {
	for (const name of ['Review', '-review', 'review-', 're--view', 're_view', 'a'.repeat(65)]) {
		assert.deepEqual(
			diagnostics(`name: ${name}\ndescription: Review`).map(item => item.code),
			['invalidName'],
		);
	}
	assert.deepEqual(
		diagnostics('name: other\ndescription: Review').map(item => item.code),
		['nameMismatch'],
	);
	assert.deepEqual(
		diagnostics(`name: review\ndescription: ${'🧩'.repeat(1024)}`).map(item => item.code),
		['headerTooLarge'],
	);
	// Folded descriptions stay within the byte-per-line limit while testing Unicode scalar counts.
	const description = (size: number) => Array.from({ length: size / 16 }, () => '  ' + '🧩'.repeat(16)).join('\n');
	assert.deepEqual(diagnostics(`name: review\ndescription: >-\n${description(960)}`), []);
	assert.deepEqual(
		diagnostics(`name: review\ndescription: >-\n${description(1040)}`).map(item => item.code),
		['fieldLength'],
	);
});

test('Skill draft optional fields and metadata reject nulls, unknown fields and bounded catalog violations', () => {
	assert.deepEqual(
		diagnostics('name: review\ndescription: Review\ncompatibility: ""\nallowed-tools: ""').map(item => item.code),
		['fieldLength', 'fieldLength'],
	);
	assert.deepEqual(diagnostics('name: review\ndescription: Review\nlicense:\ncompatibility:\nallowed-tools:'), []);
	assert.deepEqual(
		diagnostics('name: review\ndescription: Review\nmetadata: { owner: }').map(item => item.code),
		['metadataShape'],
	);
	assert.deepEqual(
		diagnostics('name: review\ndescription: Review\nmodel: future').map(item => item.severity),
		[LanguageDiagnosticSeverity.Error],
	);
	const metadata = Array.from({ length: 65 }, (_, index) => `  key${index}: value`).join('\n');
	assert.deepEqual(
		diagnostics(`name: review\ndescription: Review\nmetadata:\n${metadata}`).map(item => item.code),
		['metadataLimits'],
	);
	assert.deepEqual(
		diagnostics(`name: review\ndescription: Review\ncompatibility: ${'x'.repeat(501)}`).map(item => item.code),
		['fieldLength'],
	);
	assert.deepEqual(
		diagnostics(`name: review\ndescription: Review\nmetadata: { "": value }`).map(item => item.code),
		['metadataLimits'],
	);
});
