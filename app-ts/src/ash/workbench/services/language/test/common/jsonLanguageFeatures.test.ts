import { CancellationToken } from '../../../../../base/common/cancellation.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { parseJsonc } from '../../../../../base/common/jsonc.js';
import { URI } from '../../../../../base/common/uri.js';
import { type JsonSchema } from '../../../../../base/common/jsonSchema.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { LanguageCompletionItemKind, LanguageCompletionTriggerKind, createLanguageFeatureRequest, type LanguageDiagnostic, type LanguageDiagnosticsPublisher } from '../../../../../editor/common/languages.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { JsonSchemaRegistry } from '../../../../../platform/jsonschemas/common/jsonSchemaRegistry.js';
import { acquireJsonLanguageDiagnostics } from '../../common/jsonLanguageDiagnostics.js';
import { createJsonCompletionProvider, createJsonFormattingProvider, createJsonHoverProvider } from '../../common/jsonLanguageFeatures.js';

const resource = URI.parse('test:/nested.jsonc');
const schema = Object.freeze({
	type: 'object' as const,
	properties: Object.freeze({
		editor: Object.freeze({
			type: 'object' as const,
			properties: Object.freeze({
				enabled: Object.freeze({ type: 'boolean' as const, default: true, title: 'Enabled', description: 'Controls the editor.' }),
			}),
		}),
	}),
});

test('generic JSON language features resolve nested schema completion, hover, and formatting', async () => {
	using registry = associatedRegistry();
	const completion = createJsonCompletionProvider(registry);
	using completionModel = new TextModel('{ "editor": { "en\n}');
	const completionPosition = new Position((0) + 1, (completionModel.getLineLength((0) + 1)) + 1);
	const completionResult = await completion.provideCompletions({
		requestId: 1,
		languageId: 'jsonc',
		resource,
		position: completionPosition,
		context: { kind: LanguageCompletionTriggerKind.Invoke },
		snapshot: completionModel.createVersionedSnapshot(),
	}, new AbortController().signal);
	assert.deepEqual(completionResult?.items.map(item => item.label), ['enabled']);

	using valueCompletionModel = new TextModel('{ "editor": { "enabled": ');
	const valueCompletionResult = await completion.provideCompletions({
		requestId: 2,
		languageId: 'jsonc',
		resource,
		position: new Position((0) + 1, (valueCompletionModel.getLineLength((0) + 1)) + 1),
		context: { kind: LanguageCompletionTriggerKind.Invoke },
		snapshot: valueCompletionModel.createVersionedSnapshot(),
	}, new AbortController().signal);
	assert.deepEqual(valueCompletionResult?.items.map(item => item.label), ['true', 'false']);

	using validModel = new TextModel('{"editor":{"enabled":true,// note\n},}');
	const signal = new AbortController().signal;
	const hover = await createJsonHoverProvider(registry).provideHover({
		...createLanguageFeatureRequest(validModel, 'jsonc', signal),
		resource,
		position: new Position((0) + 1, (13) + 1),
	}, signal);
	assert.deepEqual(hover?.contents, ['Enabled', 'Controls the editor.', 'Default: true']);

	validModel.setLanguage('jsonc');
	const edits = await createJsonFormattingProvider().provideDocumentFormattingEdits(validModel, { tabSize: 2, insertSpaces: true }, CancellationToken.None);
	assert.ok(edits);
	assert.equal(edits.length, 1);
	assert.match(edits[0]!.text, /\/\/ note/u);
	assert.deepEqual(parseJsonc(edits[0]!.text, 'formatted document'), { editor: { enabled: true } });

	validModel.setLanguage('json');
	const strictJsonEdits = await createJsonFormattingProvider().provideDocumentFormattingEdits(validModel, { tabSize: 2, insertSpaces: true }, CancellationToken.None);
	assert.deepEqual(strictJsonEdits, []);
});

test('JSON resources publish syntax diagnostics and associated schemas add validation', () => {
	using registry = associatedRegistry();
	using model = new TextModel('{ "editor": { "enabled": "yes" } }');
	let diagnostics: readonly LanguageDiagnostic[] = [];
	const publisher: LanguageDiagnosticsPublisher = {
		update(_revision, next): void {
			diagnostics = next;
		},
		dispose(): void { },
		[Symbol.dispose](): void { },
	};
	using registration = acquireJsonLanguageDiagnostics(resource, 'jsonc', model, () => publisher, registry)!;

	assert.match(diagnostics[0]?.message ?? '', /Expected boolean/u);
	model.reset('{ "editor": { "enabled": true, }, }');
	assert.deepEqual(diagnostics, []);

	using strictModel = new TextModel('{ "enabled": true, // comment\n }');
	let strictDiagnostics: readonly LanguageDiagnostic[] = [];
	using strictRegistration = acquireJsonLanguageDiagnostics(URI.parse('test:/unassociated.json'), 'json', strictModel, () => ({
		update(_revision, next): void {
			strictDiagnostics = next;
		},
		dispose(): void { },
		[Symbol.dispose](): void { },
	}), registry)!;
	assert.match(strictDiagnostics.map(diagnostic => diagnostic.message).join('\n'), /Comments/u);
});

for (const [label, source, expected] of [
	['empty array', '{"preferences":[|]}', '{"preferences":["text"]}'],
	['existing item', '{"preferences":["html","te|xt"]}', '{"preferences":["html","text"]}'],
	['unfinished item', '{"preferences":["te|', '{"preferences":["text"'],
	['comment after comma', '{"preferences":["html", /* keep */ |]}', '{"preferences":["html", /* keep */ "text"]}'],
	['insertion before another item', '{"preferences":[| "html"]}', '{"preferences":["text", "html"]}'],
] as const) {
	test(`JSON array completion preserves surrounding values for ${label}`, async () => {
		using registry = new JsonSchemaRegistry();
		const itemSchema: JsonSchema = {
			type: 'string',
			anyOf: [
				{ type: 'string' },
				{ enum: ['text', 'html'], enumDescriptions: ['Plain content', 'Markup'] },
				{ enum: ['text'] },
			],
		};
		using schemaRegistration = registry.registerSchema('test://schema/array', {
			type: 'object', properties: { preferences: { type: 'array', items: itemSchema } },
		});
		using association = registry.registerAssociation(resource, 'test://schema/array');
		using model = new TextModel(source.replace('|', ''));
		const result = await createJsonCompletionProvider(registry).provideCompletions({
			requestId: 1, languageId: 'jsonc', resource,
			position: model.getPositionAt(source.indexOf('|')),
			context: { kind: LanguageCompletionTriggerKind.Invoke }, snapshot: model.createVersionedSnapshot(),
		}, new AbortController().signal);
		assert.deepEqual(result?.items.map(item => [item.label, item.kind, item.detail]), [
			['"text"', LanguageCompletionItemKind.Enum, 'Plain content'],
			['"html"', LanguageCompletionItemKind.Enum, 'Markup'],
		]);
		const item = result!.items[0]!;
		model.applyEdits([{ range: item.range!, text: item.insertText! }]);
		assert.equal(model.getValue(), expected);
	});
}

test('JSON completion resolves nested and root array items through oneOf schemas', async () => {
	using registry = new JsonSchemaRegistry();
	using registration = registry.registerSchema('test://schema/root-array', {
		type: 'array', items: { type: 'array', items: { oneOf: [{ enum: [true] }, { enum: [false] }] } },
	});
	using association = registry.registerAssociation(resource, 'test://schema/root-array');
	using model = new TextModel('[[true],[]]');
	const result = await createJsonCompletionProvider(registry).provideCompletions({
		requestId: 1, languageId: 'jsonc', resource, position: model.getPositionAt(9),
		context: { kind: LanguageCompletionTriggerKind.Invoke }, snapshot: model.createVersionedSnapshot(),
	}, new AbortController().signal);
	assert.deepEqual(result?.items.map(item => item.label), ['true', 'false']);
	const item = result!.items[1]!;
	model.applyEdits([{ range: item.range!, text: item.insertText! }]);
	assert.equal(model.getValue(), '[[true],[false]]');
});

test('JSON completion does not replace a populated array with its default after the array closes', async () => {
	using registry = new JsonSchemaRegistry();
	using registration = registry.registerSchema('test://schema/array-default', {
		type: 'object', properties: { preferences: { type: 'array', default: [], items: { enum: ['text'] } } },
	});
	using association = registry.registerAssociation(resource, 'test://schema/array-default');
	using model = new TextModel('{"preferences":["text"]}');
	const result = await createJsonCompletionProvider(registry).provideCompletions({
		requestId: 1, languageId: 'jsonc', resource, position: model.getPositionAt(model.getValue().indexOf(']') + 1),
		context: { kind: LanguageCompletionTriggerKind.Invoke }, snapshot: model.createVersionedSnapshot(),
	}, new AbortController().signal);
	assert.equal(result, undefined);
});

function associatedRegistry(): JsonSchemaRegistry {
	const registry = new JsonSchemaRegistry();
	registry.registerSchema('test://schema/nested', schema);
	registry.registerAssociation(resource, 'test://schema/nested');
	return registry;
}

for (const [label, markedSource, expected] of [
	['conditional arguments', '[{"command":"editor.action.pasteAs","args":{"|":null}}]', ['kind', 'preferences']],
	['provider kind', '[{"command":"editor.action.pasteAs","args":{"kind":|}}]', ['"text"', '"uri"']],
	['ordered preferences', '[{"command":"editor.action.pasteAs","args":{"preferences":[|]}}]', ['"text"', '"uri"']],
	['unrelated command', '[{"command":"other.command","args":{"|":null}}]', []],
] as const) {
	test(`JSON completion follows allOf command conditions for ${label}`, async () => {
		using registry = new JsonSchemaRegistry();
		using schemaRegistration = registry.registerSchema('test://conditional-keybindings', {
			type: 'array', items: {
				type: 'object', properties: { command: { type: 'string' }, args: { type: 'object' } },
				allOf: [{
					if: { required: ['command'], properties: { command: { const: 'editor.action.pasteAs' } } },
					then: { properties: { args: { anyOf: [{ type: 'object', properties: { kind: { enum: ['text', 'uri'] } } }, { type: 'object', properties: { preferences: { type: 'array', items: { enum: ['text', 'uri'] } } } }] } } },
				}],
			},
		});
		using association = registry.registerAssociation(resource, 'test://conditional-keybindings');
		const offset = markedSource.indexOf('|');
		using model = new TextModel(markedSource.replace('|', ''));
		const result = await createJsonCompletionProvider(registry).provideCompletions({
			requestId: 1, resource, languageId: 'jsonc', position: model.getPositionAt(offset),
			context: { kind: LanguageCompletionTriggerKind.Invoke }, snapshot: model.createVersionedSnapshot(),
		}, new AbortController().signal);
		assert.deepEqual(result?.items.map(item => item.label) ?? [], expected);
	});
}
