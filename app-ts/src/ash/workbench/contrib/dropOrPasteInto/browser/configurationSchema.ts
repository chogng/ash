import { Emitter } from '../../../../base/common/event.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { pasteAsCommandId } from '../../../../editor/contrib/dropOrPasteInto/browser/copyPasteContribution.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { type JsonSchema } from '../../../../base/common/jsonSchema.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { pasteAsPreferenceConfig } from '../../../../editor/contrib/dropOrPasteInto/browser/copyPasteController.js';
import { dropAsPreferenceConfig } from '../../../../editor/contrib/dropOrPasteInto/browser/dropIntoEditorController.js';
import { localize } from '../../../../nls.js';
import { ConfigurationScope, type IConfigurationKeyDefinition } from '../../../../platform/configuration/common/configurationRegistry.js';
import { type IWorkbenchContribution } from '../../../common/contributions.js';

const pasteKinds: string[] = [];
const dropKinds: string[] = [];

function preferenceDefinition(
	key: string,
	kinds: readonly string[],
	description: () => string,
): IConfigurationKeyDefinition<readonly string[]> {
	return {
		key,
		defaultValue: [],
		scope: ConfigurationScope.LANGUAGE_OVERRIDABLE,
		parse: value => {
			if (!Array.isArray(value) || !value.every(kind => typeof kind === 'string')) {
				throw new TypeError(`${key} must be an array of edit kinds`);
			}
			return [...value];
		},
		schema: {
			type: 'array',
			get description() { return description(); },
			items: {
				type: 'string',
				get description() { return localize('dropOrPaste.editKind', 'The kind identifier of the edit.'); },
				anyOf: [{ type: 'string' }, { enum: kinds }],
			},
		},
	};
}

export const editorConfiguration = [
	preferenceDefinition(pasteAsPreferenceConfig, pasteKinds, () => localize(
		'dropOrPaste.pastePreferences',
		'Preferred paste edit kinds, in order. The first available matching edit is used.',
	)),
	preferenceDefinition(dropAsPreferenceConfig, dropKinds, () => localize(
		'dropOrPaste.dropPreferences',
		'Preferred drop edit kinds, in order. The first available matching edit is used.',
	)),
];

/** Provider declarations supply suggestions; unregistered kinds remain valid user preferences. */
export class DropOrPasteSchemaContribution extends Disposable implements IWorkbenchContribution {
	public static readonly ID = 'workbench.contrib.dropOrPasteIntoSchema';

	private readonly schemaChanged = this._register(new Emitter<void>());

	constructor(
		@ILanguageFeaturesService features: ILanguageFeaturesService,
		@IKeybindingService keybindings: IKeybindingService,
	) {
		super();
		const updatePaste = (): void => {
			const kinds = features.documentPasteEditProvider.allNoModel()
				.flatMap(provider => provider.providedPasteEditKinds.map(kind => kind.value));
			pasteKinds.splice(0, pasteKinds.length, ...new Set(kinds));
			this.schemaChanged.fire();
		};
		const updateDrop = (): void => {
			const kinds = features.documentDropEditProvider.allNoModel()
				.flatMap(provider => provider.providedDropEditKinds?.map(kind => kind.value) ?? []);
			dropKinds.splice(0, dropKinds.length, ...new Set(kinds));
		};
		this._register(features.documentPasteEditProvider.onDidChange(updatePaste));
		this._register(features.documentDropEditProvider.onDidChange(updateDrop));
		updatePaste();
		updateDrop();
		this._register(keybindings.registerSchemaContribution({
			onDidChange: this.schemaChanged.event,
			getSchemaAdditions: (): JsonSchema[] => [{
				if: { required: ['command'], properties: { command: { const: pasteAsCommandId } } },
				then: {
					properties: {
						args: {
							type: 'object',
							oneOf: [
								{
									required: ['kind'],
									properties: {
										kind: { type: 'string', anyOf: [{ enum: [...pasteKinds] }, { type: 'string' }] },
									},
								},
								{
									required: ['preferences'],
									properties: {
										preferences: {
											type: 'array',
											items: { type: 'string', anyOf: [{ enum: [...pasteKinds] }, { type: 'string' }] },
										},
									},
								},
							],
						},
					},
				},
			}],
		}));
	}
}
