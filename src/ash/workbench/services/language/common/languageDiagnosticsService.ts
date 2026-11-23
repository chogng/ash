import { type LanguageDiagnosticSnapshot, type LanguageDiagnosticsHost } from '../../../../editor/common/languages.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { URI } from '../../../../base/common/uri.js';

/** Owns diagnostic aggregation across open models and unopened workspace resources. */
export interface ILanguageDiagnosticsService extends LanguageDiagnosticsHost {
	getAllDiagnostics(): readonly LanguageDiagnosticSnapshot[];
	/** A document request must await retirement of the previous binding for this resource. */
	getPendingDocumentClose(resource: URI): Promise<void> | undefined;
}

export const ILanguageDiagnosticsService = createServiceIdentifier<ILanguageDiagnosticsService>('languageDiagnosticsService');

export { type LanguageDiagnosticSnapshot, type LanguageDiagnosticsPublisher } from '../../../../editor/common/languages.js';
