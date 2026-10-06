import { Emitter } from '../../../../base/common/event.js';
import { HierarchicalKind } from '../../../../base/common/hierarchicalKind.js';
import type { JsonSchema } from '../../../../base/common/jsonSchema.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { CodeActionKind } from '../../../../editor/contrib/codeAction/common/types.js';
import { localize } from '../../../../nls.js';
import { ConfigurationScope, type IConfigurationKeyDefinition } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';

type SaveMode = 'always' | 'explicit' | 'never';
type SaveActions = Readonly<Record<string, SaveMode>>;

const sourceKinds = new Set<string>();

function saveModeSchema(notebook: boolean): JsonSchema {
	const modes: readonly SaveMode[] = notebook ? ['explicit', 'never'] : ['always', 'explicit', 'never'];
	const descriptions = {
		always: localize('codeActions.save.always', 'Run on explicit saves and on auto saves caused by focus or window changes.'),
		explicit: localize('codeActions.save.explicit', 'Run only when you explicitly save.'),
		never: localize('codeActions.save.never', 'Do not run on save.'),
	};
	return {
		type: ['string', 'boolean'],
		default: 'explicit',
		enum: [...modes, true, false],
		enumDescriptions: [
			...modes.map(mode => descriptions[mode]),
			localize('codeActions.save.true', 'Run only when you explicitly save. Use "explicit" instead of true.'),
			localize('codeActions.save.false', 'Do not run on save. Use "never" instead of false.'),
		],
	};
}

function saveActionsDefinition(key: string, notebook: boolean): IConfigurationKeyDefinition<SaveActions> {
	return {
		key,
		defaultValue: {},
		scope: ConfigurationScope.LANGUAGE_OVERRIDABLE,
		parse: value => {
			const invalid = (): TypeError => new TypeError(localize('codeActions.save.invalid', '{0} must map action kinds to supported save modes.', key));
			if (!value || typeof value !== 'object') { throw invalid(); }
			if (Array.isArray(value)) {
				if (!value.every(kind => typeof kind === 'string')) { throw invalid(); }
				return Object.fromEntries(value.map(kind => [kind, 'explicit' as const]));
			}
			return Object.fromEntries(Object.entries(value).map(([kind, mode]) => {
				if (typeof mode === 'boolean') { return [kind, mode ? 'explicit' : 'never']; }
				if (mode !== 'explicit' && mode !== 'never' && (notebook || mode !== 'always')) { throw invalid(); }
				return [kind, mode];
			}));
		},
		schema: {
			type: ['object', 'array'],
			get markdownDescription() {
				return notebook
					? localize('codeActions.save.notebook', 'Code actions to run when saving a notebook. Example: `"notebook.source.organizeImports": "explicit"`. Auto saves after a delay do not run these actions.')
					: localize('codeActions.save.editor', 'Code actions to run when saving a file. Example: `"source.organizeImports": "explicit"`. Auto saves after a delay do not run these actions.');
			},
			get properties() {
				return Object.fromEntries([...sourceKinds].map(kind => [kind, {
					...saveModeSchema(notebook),
					description: localize('codeActions.save.kind', 'Choose when to run {0} on save.', kind),
				}]));
			},
			get additionalProperties() { return saveModeSchema(notebook); },
			items: { type: 'string' },
		},
	};
}

export const editorConfiguration = saveActionsDefinition('editor.codeActionsOnSave', false);
export const notebookEditorConfiguration = saveActionsDefinition('notebook.codeActionsOnSave', true);

/** Settings and shortcuts read provider declarations; document action queries remain editor-owned. */
export class CodeActionsContribution extends Disposable implements IWorkbenchContribution {
	public static readonly ID = 'workbench.contrib.codeActions';
	private readonly schemaChanged = this._register(new Emitter<void>());

	constructor(
		@ILanguageFeaturesService features: ILanguageFeaturesService,
		@IKeybindingService keybindings: IKeybindingService,
	) {
		super();
		const kinds = (): string[] => [...new Set(features.codeActionProvider.allNoModel().flatMap(provider => provider.providedCodeActionKinds ?? []))];
		const update = (): void => {
			sourceKinds.clear();
			for (const kind of kinds()) {
				if (CodeActionKind.Source.contains(new HierarchicalKind(kind))) { sourceKinds.add(kind); }
			}
			this.schemaChanged.fire();
		};
		this._register(toDisposable(() => sourceKinds.clear()));
		this._register(features.codeActionProvider.onDidChange(update));
		update();
		this._register(keybindings.registerSchemaContribution({
			onDidChange: this.schemaChanged.event,
			getSchemaAdditions: (): JsonSchema[] => {
				const declared = kinds();
				return ([
					['editor.action.codeAction', HierarchicalKind.Empty],
					['editor.action.refactor', CodeActionKind.Refactor],
					['editor.action.sourceAction', CodeActionKind.Source],
				] as const).map(([command, parent]) => ({
					if: { required: ['command'], properties: { command: { const: command } } },
					then: {
						properties: {
							args: {
								type: 'object',
								properties: {
									kind: {
										type: 'string',
										anyOf: [{ enum: declared.filter(kind => parent.contains(new HierarchicalKind(kind))) }, { type: 'string' }],
									},
								},
							},
						},
					},
				}));
			},
		}));
	}
}
