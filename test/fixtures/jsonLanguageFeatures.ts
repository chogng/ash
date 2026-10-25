import { JsonLanguageFeatures, type JsonDocumentSnapshot } from '../../extensions/json-language-features/languageFeatures.js';
import { Registry } from '../../src/ash/platform/registry/common/platform.js';
import { Extensions, type IJSONContributionRegistry } from '../../src/ash/platform/jsonschemas/common/jsonContributionRegistry.js';
import { Range } from '../../src/ash/editor/common/core/range.js';
import { parseSnippet } from '../../src/ash/editor/contrib/snippet/common/snippetParser.js';
import { LanguageCompletionItemKind, LanguageDiagnosticSeverity, type LanguageCompletionProvider, type LanguageHoverProvider, type DocumentFormattingEditProvider, type LanguageDiagnosticsPublisher } from '../../src/ash/editor/common/languages.js';
import type { TextModel } from '../../src/ash/editor/common/model/textModel.js';
import type { URI } from '../../src/ash/base/common/uri.js';
import { toDisposable } from '../../src/ash/base/common/lifecycle.js';

const registry = Registry.as<IJSONContributionRegistry>(Extensions.JSONContribution);
const range = (value: { start: { line: number; character: number }; end: { line: number; character: number } }): Range => new Range(value.start.line + 1, value.start.character + 1, value.end.line + 1, value.end.character + 1);

async function engine(contributions: IJSONContributionRegistry): Promise<JsonLanguageFeatures> {
	return new JsonLanguageFeatures(async () => {
		const associations = contributions.getSchemaAssociations();
		return JSON.parse(JSON.stringify(Object.entries(contributions.getSchemaContributions().schemas).map(([uri, schema]) => ({ uri, fileMatch: associations[uri] ?? [], schema }))));
	});
}

export function createJsonCompletionProvider(contributions = registry): LanguageCompletionProvider {
	const service = engine(contributions);
	return {
		id: 'test.json.extension', languageIds: ['json', 'jsonc'],
		async provideCompletions(request, signal) {
			const features = await service;
			features.invalidateSchemas();
			const result = await features.complete({ uri: request.resource?.toString() ?? 'untitled:/test.json', languageId: request.languageId, version: request.snapshot.version, text: request.snapshot.getText() }, { line: request.position.lineNumber - 1, character: request.position.column - 1 });
			signal.throwIfAborted();
			return result?.items.length ? { isIncomplete: result.isIncomplete, items: result.items.map((item, index) => {
				const edit = item.textEdit && 'range' in item.textEdit ? item.textEdit : undefined;
				const text = edit?.newText ?? item.insertText ?? item.label;
				return { id: String(index), label: item.label, kind: item.kind === 10 ? LanguageCompletionItemKind.Property : item.kind === 13 ? LanguageCompletionItemKind.Enum : LanguageCompletionItemKind.Value, range: edit ? range(edit.range) : Range.fromPositions(request.position), insertText: item.insertTextFormat === 2 ? parseSnippet(text).text : text, detail: item.detail, documentation: typeof item.documentation === 'string' ? item.documentation : item.documentation?.value };
			}) } : undefined;
		},
	};
}

export function createJsonHoverProvider(contributions = registry): LanguageHoverProvider {
	const service = engine(contributions);
	return { async provideHover(request, signal) {
		const features = await service;
		features.invalidateSchemas();
		const value = await features.hover({ uri: request.resource?.toString() ?? 'untitled:/test.json', languageId: request.languageId, version: request.snapshot.version, text: request.snapshot.getText() }, { line: request.position.lineNumber - 1, character: request.position.column - 1 });
		signal.throwIfAborted();
		if (!value) return undefined;
		return { contents: (Array.isArray(value.contents) ? value.contents : [value.contents]).map(value => typeof value === 'string' ? value : value.value), ...(value.range ? { range: range(value.range) } : {}) };
	} };
}

export function createJsonFormattingProvider(): DocumentFormattingEditProvider {
	return { async provideDocumentFormattingEdits(model, options) { return (await engine(registry)).format({ uri: model.uri.toString(), languageId: model.getLanguageId(), version: model.getVersionId(), text: model.getValue() }, options).map(edit => ({ range: range(edit.range), text: edit.newText })); } };
}

export async function acquireJsonLanguageDiagnostics(resource: URI, languageId: string, model: TextModel, createPublisher: () => LanguageDiagnosticsPublisher, contributions = registry) {
	const features = await engine(contributions);
	const publisher = createPublisher();
	let pending: Promise<void> = Promise.resolve();
	let disposed = false;
	const update = (): void => {
		features.invalidateSchemas();
		const source: JsonDocumentSnapshot = { uri: resource.toString(), languageId, version: model.version, text: model.getValue() };
		pending = features.validate(source).then(values => {
			if (disposed || model.version !== source.version) return;
			publisher.update(source.version, values.map(value => ({ range: range(value.range), severity: value.severity === 2 ? LanguageDiagnosticSeverity.Warning : LanguageDiagnosticSeverity.Error, message: typeof value.message === 'string' ? value.message : value.message.value, source: 'json' })));
		});
	};
	const listeners = [model.onDidChangeContent(update), contributions.onDidChangeSchema(update), contributions.onDidChangeSchemaAssociations(update)];
	update();
	await pending;
	return Object.assign(toDisposable(() => { disposed = true; for (const listener of listeners) listener.dispose(); publisher.dispose(); }), { settled: () => pending });
}
