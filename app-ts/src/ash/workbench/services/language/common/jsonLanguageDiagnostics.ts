import { parseJsonDocument } from '../../../../base/common/json.js';
import { validateJsonSchema } from '../../../../base/common/jsonSchema.js';
import { DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { Range } from '../../../../editor/common/core/range.js';
import { LanguageDiagnosticSeverity, type LanguageDiagnostic, type LanguageDiagnosticsPublisher } from '../../../../editor/common/languages.js';
import type { TextModel } from '../../../../editor/common/model/textModel.js';
import { JsonSchemasRegistry, type JsonSchemaRegistry } from '../../../../platform/jsonschemas/common/jsonSchemaRegistry.js';

/** Publishes local syntax diagnostics for JSON and adds schema diagnostics when associated. */
export function acquireJsonLanguageDiagnostics(
	resource: URI,
	languageId: string,
	model: TextModel,
	createPublisher: () => LanguageDiagnosticsPublisher,
	registry: JsonSchemaRegistry = JsonSchemasRegistry,
): IDisposable | undefined {
	if (languageId !== 'json' && languageId !== 'jsonc') return undefined;
	const store = new DisposableStore();
	const publisher = createPublisher();
	store.add(publisher);
	const update = (): void => {
		const source = model.getText();
		const document = parseJsonDocument(source, {
			allowComments: languageId === 'jsonc',
			allowTrailingComma: languageId === 'jsonc',
		});
		const diagnostics: LanguageDiagnostic[] = document.errors.map(error => Object.freeze({
			range: diagnosticRange(model, error.offset, error.length),
			severity: LanguageDiagnosticSeverity.Error,
			message: error.message,
			source: 'json',
		}));
		if (document.errors.length === 0) {
			const schema = registry.getSchemaForResource(resource);
			for (const issue of validateJsonSchema(document, schema)) {
				diagnostics.push(Object.freeze({
					range: diagnosticRange(model, issue.offset, issue.length),
					severity: LanguageDiagnosticSeverity.Warning,
					message: issue.message,
					source: 'json-schema',
				}));
			}
		}
		publisher.update(model.version, Object.freeze(diagnostics));
	};
	store.add(model.onDidChangeContent(update));
	store.add(registry.onDidChange(event => {
		if (event.resource?.toString() === resource.toString() || !event.resource && registry.getSchemaIdForResource(resource) === event.schemaId) update();
	}));
	update();
	return store;
}

function diagnosticRange(model: TextModel, offset: number, length: number): Range {
	const start = Math.max(0, Math.min(model.length, offset));
	const end = Math.max(start, Math.min(model.length, offset + length));
	return Range.fromPositions(model.positionAt(start), model.positionAt(end));
}
