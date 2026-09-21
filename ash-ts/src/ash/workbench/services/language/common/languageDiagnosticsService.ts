import { type LanguageDiagnosticSnapshot, type LanguageDiagnosticsHost } from '../../../../editor/common/languages.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

/** Owns diagnostic aggregation across open models and unopened workspace resources. */
export interface ILanguageDiagnosticsService extends LanguageDiagnosticsHost {
	getAllDiagnostics(): readonly LanguageDiagnosticSnapshot[];
}

export const ILanguageDiagnosticsService = createServiceIdentifier<ILanguageDiagnosticsService>('languageDiagnosticsService');

export { type LanguageDiagnosticSnapshot, type LanguageDiagnosticsPublisher } from '../../../../editor/common/languages.js';
