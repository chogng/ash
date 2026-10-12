import { Range } from '../../../../../../editor/common/core/range.js';
import { LanguageDiagnosticSeverity, type LanguageDiagnostic } from '../../../../../../editor/common/languages.js';
import { localize } from '../../../../../../nls.js';
import type { ParsedPromptFile } from '../promptFileParser.js';
import { getValidAttributeNames } from './promptFileAttributes.js';

/** Draft feedback only. The shared Skill catalog still validates every accepted file. */
export class PromptValidator {
	public validate(promptAST: ParsedPromptFile): readonly LanguageDiagnostic[] {
		const header = promptAST.header;
		if (!header) return [{ range: promptAST.body?.range ?? new Range(1, 1, 1, 1), severity: LanguageDiagnosticSeverity.Error, code: 'missingHeader', source: 'Skill', message: localize('prompt.validation.header', 'A Skill requires a YAML header enclosed by --- lines.') }];
		const diagnostics: LanguageDiagnostic[] = header.errors.map(error => ({ ...error, severity: LanguageDiagnosticSeverity.Error, source: 'Skill' }));
		const known = new Set(getValidAttributeNames());
		for (const attribute of header.attributes) {
			if (!known.has(attribute.key)) {
				diagnostics.push({ range: attribute.range, severity: LanguageDiagnosticSeverity.Warning, code: 'unknownField', source: 'Skill', message: localize('prompt.validation.unknown', 'The Skill catalog does not accept the field {0}.', attribute.key) });
			} else if (attribute.key === 'metadata') {
				if (attribute.value.type !== 'map' || attribute.value.properties.some(property => property.value.type !== 'scalar')) {
					diagnostics.push({ range: attribute.value.range, severity: LanguageDiagnosticSeverity.Error, code: 'metadataShape', source: 'Skill', message: localize('prompt.validation.metadata', 'Metadata must map names to text values.') });
				}
			} else if (attribute.value.type !== 'scalar') {
				diagnostics.push({ range: attribute.value.range, severity: LanguageDiagnosticSeverity.Error, code: 'textField', source: 'Skill', message: localize('prompt.validation.text', 'The Skill field {0} requires a text value.', attribute.key) });
			}
		}
		for (const key of ['name', 'description']) {
			const attribute = header.getAttribute(key);
			if (!attribute || (attribute.value.type === 'scalar' && !attribute.value.value.trim())) {
				diagnostics.push({ range: attribute?.range ?? header.range, severity: LanguageDiagnosticSeverity.Error, code: 'requiredField', source: 'Skill', message: localize('prompt.validation.required', 'The Skill header requires a non-empty {0} field.', key) });
			}
		}
		return diagnostics;
	}
}
