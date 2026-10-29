import { Range } from '../../../../../../editor/common/core/range.js';
import { LanguageDiagnosticSeverity, type LanguageDiagnostic } from '../../../../../../editor/common/languages.js';
import { localize } from '../../../../../../nls.js';
import type { IHeaderAttribute, ParsedPromptFile } from '../promptFileParser.js';
import { getAttributeDefinition, getValidAttributeNames } from './promptFileAttributes.js';

/** Draft feedback only. The shared Skill catalog still validates every accepted file. */
export class PromptValidator {
	public validate(promptAST: ParsedPromptFile): readonly LanguageDiagnostic[] {
		const header = promptAST.header;
		if (!header)
			return [
				{
					range: promptAST.body?.range ?? new Range(1, 1, 1, 1),
					severity: LanguageDiagnosticSeverity.Error,
					code: 'missingHeader',
					source: 'Skill',
					message: localize(
						'prompt.validation.header',
						'A Skill requires a YAML header enclosed by --- lines.',
					),
				},
			];
		const diagnostics: LanguageDiagnostic[] = header.errors.map(error => ({
			...error,
			severity: LanguageDiagnosticSeverity.Error,
			source: 'Skill',
		}));
		if (header.errors.some(error => error.code === 'headerTooLarge')) return diagnostics;
		const known = new Set(getValidAttributeNames());
		const report = (attribute: IHeaderAttribute, code: string, message: string): void => {
			diagnostics.push({
				range: attribute.value.range,
				severity: LanguageDiagnosticSeverity.Error,
				code,
				source: 'Skill',
				message,
			});
		};
		const length = (value: string): number => [...value].length;
		for (const attribute of header.attributes) {
			if (!known.has(attribute.key)) {
				diagnostics.push({
					range: attribute.range,
					severity: LanguageDiagnosticSeverity.Error,
					code: 'unknownField',
					source: 'Skill',
					message: localize(
						'prompt.validation.unknown',
						'The Skill catalog does not accept the field {0}.',
						attribute.key,
					),
				});
			} else if (attribute.key === 'metadata') {
				if (
					attribute.value.type !== 'map' ||
					attribute.value.properties.some(
						property => property.value.type !== 'scalar' || property.value.missing,
					)
				) {
					diagnostics.push({
						range: attribute.value.range,
						severity: LanguageDiagnosticSeverity.Error,
						code: 'metadataShape',
						source: 'Skill',
						message: localize('prompt.validation.metadata', 'Metadata must map names to text values.'),
					});
				} else if (
					attribute.value.properties.length > 64 ||
					attribute.value.properties.some(
						property =>
							!property.key.value ||
							length(property.key.value) > 128 ||
							(property.value.type === 'scalar' && length(property.value.value) > 1024),
					)
				) {
					report(
						attribute,
						'metadataLimits',
						localize(
							'prompt.validation.metadataLimits',
							'Metadata supports up to 64 entries, with names of 1 to 128 characters and values of up to 1024 characters.',
						),
					);
				}
			} else if (attribute.value.type !== 'scalar') {
				diagnostics.push({
					range: attribute.value.range,
					severity: LanguageDiagnosticSeverity.Error,
					code: 'textField',
					source: 'Skill',
					message: localize(
						'prompt.validation.text',
						'The Skill field {0} requires a text value.',
						attribute.key,
					),
				});
			} else if (!attribute.value.missing) {
				const value = attribute.value.value;
				if (attribute.key === 'name' && value) {
					if (
						value.length > getAttributeDefinition('name')!.maximumCharacters! ||
						!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
					) {
						report(
							attribute,
							'invalidName',
							localize(
								'prompt.validation.name',
								'A Skill name requires 1 to 64 lowercase letters, numbers and single hyphens.',
							),
						);
					} else {
						const directory = promptAST.uri.path.split('/').at(-2);
						if (directory && value !== directory)
							report(
								attribute,
								'nameMismatch',
								localize(
									'prompt.validation.nameMismatch',
									'The Skill name {0} must match its parent directory {1}.',
									value,
									directory,
								),
							);
					}
				}
				const maximum =
					attribute.key === 'name' ? undefined : getAttributeDefinition(attribute.key)?.maximumCharacters;
				if (
					maximum !== undefined &&
					((!value.trim() && attribute.key === 'compatibility') ||
						(!value && attribute.key === 'allowed-tools') ||
						length(value) > maximum)
				) {
					report(
						attribute,
						'fieldLength',
						localize(
							'prompt.validation.length',
							'The Skill field {0} requires 1 to {1} characters.',
							attribute.key,
							maximum,
						),
					);
				}
			}
		}
		for (const key of ['name', 'description']) {
			const attribute = header.getAttribute(key);
			if (
				!attribute ||
				(attribute.value.type === 'scalar' && (attribute.value.missing || !attribute.value.value.trim()))
			) {
				diagnostics.push({
					range: attribute?.range ?? header.range,
					severity: LanguageDiagnosticSeverity.Error,
					code: 'requiredField',
					source: 'Skill',
					message: localize(
						'prompt.validation.required',
						'The Skill header requires a non-empty {0} field.',
						key,
					),
				});
			}
		}
		return diagnostics;
	}
}
