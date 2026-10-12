import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../../../base/common/uri.js';
import { Position } from '../../../../../../../editor/common/core/position.js';
import { Range } from '../../../../../../../editor/common/core/range.js';
import { TextModel } from '../../../../../../../editor/common/model/textModel.js';
import { LanguageCompletionTriggerKind } from '../../../../../../../editor/common/languages.js';
import { PromptHeaderAutocompletion } from '../../../../common/promptSyntax/languageProviders/promptHeaderAutocompletion.js';
import { PromptHoverProvider } from '../../../../common/promptSyntax/languageProviders/promptHovers.js';

function complete(source: string, position: Position, name = 'SKILL.md', aborted = false) {
	using model = new TextModel(source, { resource: URI.file(`/skills/review/${name}`), languageId: 'markdown' });
	const controller = new AbortController();
	if (aborted) controller.abort();
	return new PromptHeaderAutocompletion().provideCompletions({
		requestId: 1, resource: model.uri, languageId: 'markdown', position,
		context: { kind: LanguageCompletionTriggerKind.Invoke }, snapshot: model.createVersionedSnapshot(),
	}, controller.signal);
}

test('Skill header completion offers the existing schema keys, excluding already present root keys', () => {
	const result = complete('---\nname: review\n\n---\nBody', new Position(3, 1));
	assert.deepEqual(result?.items.map(item => item.label), ['description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
	const filtered = complete('---\nname: review\nde\n---', new Position(3, 3));
	assert.deepEqual(filtered?.items.map(item => ({ label: item.label, insertText: item.insertText, range: item.range })), [
		{ label: 'description', insertText: 'description: ', range: new Range(3, 1, 3, 3) },
	]);
});

test('Skill completion does not enter body, nested mappings, other files or cancelled requests', () => {
	assert.equal(complete('---\nmetadata:\n  key\n---', new Position(3, 6)), undefined);
	assert.equal(complete('---\nname: review\n---\nde', new Position(4, 3)), undefined);
	assert.equal(complete('---\nde', new Position(2, 3), 'README.md'), undefined);
	assert.equal(complete('Body\nde', new Position(2, 3)), undefined);
	assert.equal(complete('---\nde', new Position(2, 3), 'SKILL.md', true), undefined);
	assert.deepEqual(complete('---\nde', new Position(2, 3))?.items.map(item => item.label), ['description']);
});

test('Skill hover describes only an existing header key at its exact range', () => {
	using model = new TextModel('---\nname: review\n---\nname: body', { resource: URI.file('/skills/review/SKILL.md'), languageId: 'markdown' });
	const controller = new AbortController();
	const request = {
		model, snapshot: model.createVersionedSnapshot(), resource: model.uri,
		languageId: 'markdown', modelLanguageId: 'markdown', signal: controller.signal, position: new Position(2, 2),
	};
	const provider = new PromptHoverProvider();
	const hover = provider.provideHover(request, controller.signal);
	assert.deepEqual(hover?.range, new Range(2, 1, 2, 5));
	assert.match(String(hover?.contents[0]), /Required.*parent directory/u);
	assert.equal(provider.provideHover({ ...request, position: new Position(2, 9) }, controller.signal), undefined);
	assert.equal(provider.provideHover({ ...request, position: new Position(4, 2) }, controller.signal), undefined);
	controller.abort();
	assert.equal(provider.provideHover(request, controller.signal), undefined);
});
