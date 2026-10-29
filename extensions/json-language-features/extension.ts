import * as ash from '@ash/sdk';
import { config as configureLocalization } from '@vscode/l10n';
import { JsonLanguageFeatures, type JsonDocumentSnapshot } from './languageFeatures.js';

const selector = ['json', 'jsonc'];
// The host bounds localization keys to 256 characters; expand this library message only inside the extension.
const dependenciesDescription =
	'A map of property names to either an array of property names or a schema. An array of property names means the property named in the key depends on the properties in the array being present in the object in order to be valid. If the value is a schema, then the schema is only applied to the object if the property in the key exists on the object.';
const snapshot = (document: ash.TextDocument): JsonDocumentSnapshot => ({
	uri: document.uri.toString(),
	languageId: document.languageId,
	version: document.version,
	text: document.getText(),
});
const range = (value: {
	start: { line: number; character: number };
	end: { line: number; character: number };
}): ash.Range => new ash.Range(value.start.line, value.start.character, value.end.line, value.end.character);

export async function activate(context: ash.ExtensionContext): Promise<void> {
	configureLocalization({
		contents: {
			...ash.l10n.bundle,
			[dependenciesDescription]:
				ash.l10n.bundle?.['json.schema.dependenciesDescription'] ?? dependenciesDescription,
		},
	});
	const features = new JsonLanguageFeatures(() => ash.languages.getJsonSchemaContributions());
	const diagnostics = ash.languages.createDiagnosticCollection('json');
	const pending = new Map<string, number>();
	let disposed = false;
	const validate = async (document: ash.TextDocument): Promise<void> => {
		if (disposed || !selector.includes(document.languageId)) return;
		const source = snapshot(document);
		const generation = (pending.get(source.uri) ?? 0) + 1;
		pending.set(source.uri, generation);
		const values = await features.validate(source);
		if (
			disposed ||
			document.isClosed ||
			document.version !== source.version ||
			pending.get(source.uri) !== generation
		)
			return;
		diagnostics.set(
			document.uri,
			values.map(value => {
				const diagnostic = new ash.Diagnostic(
					range(value.range),
					typeof value.message === 'string' ? value.message : value.message.value,
					(value.severity ?? 1) - 1,
				);
				diagnostic.source = 'json';
				diagnostic.code = value.code;
				return diagnostic;
			}),
		);
	};
	context.subscriptions.push(
		new ash.Disposable(() => {
			disposed = true;
			pending.clear();
		}),
		diagnostics,
		ash.workspace.onDidOpenTextDocument(validate),
		ash.workspace.onDidChangeTextDocument(event => validate(event.document)),
		ash.workspace.onDidCloseTextDocument(document => {
			pending.delete(document.uri.toString());
			diagnostics.delete(document.uri);
		}),
		ash.languages.onDidChangeJsonSchemas(async () => {
			features.invalidateSchemas();
			await Promise.all(ash.workspace.textDocuments.map(validate));
		}),
		ash.languages.registerCompletionItemProvider(
			selector,
			{
				async provideCompletionItems(document, position, token) {
					const result = await features.complete(snapshot(document), position);
					if (token.isCancellationRequested) return undefined;
					return new ash.CompletionList(
						(result?.items ?? []).map(value => {
							const item = new ash.CompletionItem(
								value.label,
								value.kind === undefined ? undefined : value.kind - 1,
							);
							const edit = value.textEdit && 'range' in value.textEdit ? value.textEdit : undefined;
							const text = edit?.newText ?? value.insertText ?? value.label;
							item.insertText = value.insertTextFormat === 2 ? new ash.SnippetString(text) : text;
							if (edit) item.range = range(edit.range);
							item.filterText = value.filterText || undefined;
							item.sortText = value.sortText || undefined;
							item.detail = value.detail || undefined;
							item.documentation =
								(typeof value.documentation === 'string'
									? value.documentation
									: value.documentation?.value) || undefined;
							return item;
						}),
						result?.isIncomplete ?? false,
					);
				},
			},
			'"',
			':',
		),
		ash.languages.registerHoverProvider(selector, {
			async provideHover(document, position, token) {
				const value = await features.hover(snapshot(document), position);
				if (!value || token.isCancellationRequested) return undefined;
				const contents = (Array.isArray(value.contents) ? value.contents : [value.contents]).filter(
					content => (typeof content === 'string' ? content : content.value).length > 0,
				);
				return contents.length
					? new ash.Hover(
							contents.map(content =>
								typeof content === 'string' ? content : new ash.MarkdownString(content.value),
							),
							value.range ? range(value.range) : undefined,
						)
					: undefined;
			},
		}),
		ash.languages.registerDocumentFormattingEditProvider(selector, {
			provideDocumentFormattingEdits: (document, options, token) =>
				token.isCancellationRequested
					? []
					: features
							.format(snapshot(document), options)
							.map(edit => new ash.TextEdit(range(edit.range), edit.newText)),
		}),
	);
	await Promise.all(ash.workspace.textDocuments.map(validate));
}
