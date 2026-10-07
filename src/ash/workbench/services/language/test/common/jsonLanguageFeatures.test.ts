import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { parseJsonc } from '../../../../../base/common/jsonc.js';
import { URI } from '../../../../../base/common/uri.js';
import { type JsonSchema } from '../../../../../base/common/jsonSchema.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { LanguageCompletionItemKind, LanguageCompletionTriggerKind, createLanguageFeatureRequest, type LanguageDiagnostic, type LanguageDiagnosticsPublisher } from '../../../../../editor/common/languages.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { Extensions as JSONExtensions, type IJSONContributionRegistry } from '../../../../../platform/jsonschemas/common/jsonContributionRegistry.js';
import { acquireJsonLanguageDiagnostics } from '../../common/jsonLanguageDiagnostics.js';
import { createJsonCompletionProvider, createJsonFormattingProvider, createJsonHoverProvider } from '../../common/jsonLanguageFeatures.js';

const jsonRegistry = Registry.as<IJSONContributionRegistry>(JSONExtensions.JSONContribution);

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
	using schemaStore = new DisposableStore();
	const registry = associatedRegistry(schemaStore);
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
	using schemaStore = new DisposableStore();
	const registry = associatedRegistry(schemaStore);
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
		using schemaStore = new DisposableStore();
		const registry = jsonRegistry;
		const itemSchema: JsonSchema = {
			type: 'string',
			anyOf: [
				{ type: 'string' },
				{ enum: ['text', 'html'], enumDescriptions: ['Plain content', 'Markup'] },
				{ enum: ['text'] },
			],
		};
		registry.registerSchema('test://schema/array', {
			type: 'object', properties: { preferences: { type: 'array', items: itemSchema } },
		}, schemaStore);
		using association = registry.registerSchemaAssociation('test://schema/array', resource.toString());
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
	using schemaStore = new DisposableStore();
	const registry = jsonRegistry;
	registry.registerSchema('test://schema/root-array', {
		type: 'array', items: { type: 'array', items: { oneOf: [{ enum: [true] }, { enum: [false] }] } },
	}, schemaStore);
	using association = registry.registerSchemaAssociation('test://schema/root-array', resource.toString());
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
	using schemaStore = new DisposableStore();
	const registry = jsonRegistry;
	registry.registerSchema('test://schema/array-default', {
		type: 'object', properties: { preferences: { type: 'array', default: [], items: { enum: ['text'] } } },
	}, schemaStore);
	using association = registry.registerSchemaAssociation('test://schema/array-default', resource.toString());
	using model = new TextModel('{"preferences":["text"]}');
	const result = await createJsonCompletionProvider(registry).provideCompletions({
		requestId: 1, languageId: 'jsonc', resource, position: model.getPositionAt(model.getValue().indexOf(']') + 1),
		context: { kind: LanguageCompletionTriggerKind.Invoke }, snapshot: model.createVersionedSnapshot(),
	}, new AbortController().signal);
	assert.equal(result, undefined);
});

function associatedRegistry(schemaStore: DisposableStore): IJSONContributionRegistry {
	const registry = jsonRegistry;
	registry.registerSchema('test://schema/nested', schema, schemaStore);
	schemaStore.add(registry.registerSchemaAssociation('test://schema/nested', resource.toString()));
	return registry;
}

test('JSON pattern associations refresh completion, hover and diagnostics while keeping each schema reference root', async () => {
	using store = new DisposableStore();
	const target = URI.parse('test:/configs/schema-events.jsonc');
	const first = {
		type: 'object' as const,
		definitions: { mode: { type: 'string' as const, enum: ['on'], description: 'First mode' } },
		properties: { mode: { $ref: '#/definitions/mode' } },
	};
	const second = {
		type: 'object' as const,
		definitions: { mode: { type: 'string' as const, enum: ['off'], description: 'Second mode' } },
		properties: { mode: { $ref: '#/definitions/mode' } },
	};
	jsonRegistry.registerSchema('test://schema/events-first', first, store);
	jsonRegistry.registerSchema('test://schema/events-second', second, store);
	store.add(jsonRegistry.registerSchemaAssociation('test://schema/events-first', '**/schema-events.jsonc'));
	const secondAssociation = store.add(jsonRegistry.registerSchemaAssociation('test://schema/events-second', target.toString()));
	using model = new TextModel('{"mode":"other"}', { resource: target, languageId: 'jsonc' });
	let diagnostics: readonly LanguageDiagnostic[] = [];
	using registration = acquireJsonLanguageDiagnostics(target, 'jsonc', model, () => ({
		update(_revision, next): void { diagnostics = next; },
		dispose(): void { },
		[Symbol.dispose](): void { },
	}))!;
	assert.equal(diagnostics.length, 2);
	using incomplete = new TextModel('{"mode":');
	const completion = await createJsonCompletionProvider().provideCompletions({
		requestId: 1, resource: target, languageId: 'jsonc', position: incomplete.getPositionAt(incomplete.length),
		context: { kind: LanguageCompletionTriggerKind.Invoke }, snapshot: incomplete.createVersionedSnapshot(),
	}, new AbortController().signal);
	assert.deepEqual(completion?.items.map(item => item.label), ['"on"', '"off"']);
	assert.equal(new Set(completion!.items.map(item => item.id)).size, completion!.items.length);
	const signal = new AbortController().signal;
	const hover = await createJsonHoverProvider().provideHover({ ...createLanguageFeatureRequest(model, 'jsonc', signal), resource: target, position: new Position(1, 3) }, signal);
	assert.deepEqual(hover?.contents, ['First mode', 'Second mode']);
	first.definitions.mode.enum = ['other'];
	jsonRegistry.notifySchemaChanged('test://schema/events-first');
	assert.equal(diagnostics.length, 1);
	secondAssociation.dispose();
	assert.deepEqual(diagnostics, []);
	first.definitions.mode.enum = ['on'];
	jsonRegistry.notifySchemaChanged('test://schema/events-first');
	assert.equal(diagnostics.length, 1);
	store.add(jsonRegistry.registerSchemaAssociation('test://schema/events-first', '!**/schema-events.jsonc'));
	assert.deepEqual(diagnostics, []);
});

for (const [label, markedSource, expected] of [
	['conditional arguments', '[{"command":"editor.action.pasteAs","args":{"|":null}}]', ['kind', 'preferences']],
	['provider kind', '[{"command":"editor.action.pasteAs","args":{"kind":|}}]', ['"text"', '"uri"']],
	['ordered preferences', '[{"command":"editor.action.pasteAs","args":{"preferences":[|]}}]', ['"text"', '"uri"']],
	['unrelated command', '[{"command":"other.command","args":{"|":null}}]', []],
] as const) {
	test(`JSON completion follows allOf command conditions for ${label}`, async () => {
		using schemaStore = new DisposableStore();
		const registry = jsonRegistry;
		registry.registerSchema('test://conditional-keybindings', {
			type: 'array', items: {
				type: 'object', properties: { command: { type: 'string' }, args: { type: 'object' } },
				allOf: [{
					if: { required: ['command'], properties: { command: { const: 'editor.action.pasteAs' } } },
					then: { properties: { args: { anyOf: [{ type: 'object', properties: { kind: { enum: ['text', 'uri'] } } }, { type: 'object', properties: { preferences: { type: 'array', items: { enum: ['text', 'uri'] } } } }] } } },
				}],
			},
		}, schemaStore);
		using association = registry.registerSchemaAssociation('test://conditional-keybindings', resource.toString());
		const offset = markedSource.indexOf('|');
		using model = new TextModel(markedSource.replace('|', ''));
		const result = await createJsonCompletionProvider(registry).provideCompletions({
			requestId: 1, resource, languageId: 'jsonc', position: model.getPositionAt(offset),
			context: { kind: LanguageCompletionTriggerKind.Invoke }, snapshot: model.createVersionedSnapshot(),
		}, new AbortController().signal);
		assert.deepEqual(result?.items.map(item => item.label) ?? [], expected);
	});
}
