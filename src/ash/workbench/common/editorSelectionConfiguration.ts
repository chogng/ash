import {
	Extensions as ConfigurationExtensions,
	type IConfigurationRegistry,
} from '../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { localize } from '../../nls.js';

export type DefaultNewDocumentEditor = 'buildMode' | 'code' | 'academy';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

/** Workbench-level editor selection preferences applied before a resource has a durable type. */
export const EditorSelectionConfiguration = Object.freeze({
	defaultNewDocumentEditor: configurationRegistry.registerConfiguration<DefaultNewDocumentEditor>({
		key: 'workbench.editor.defaultNewDocumentEditor',
		defaultValue: 'buildMode',
		parse(value: unknown): DefaultNewDocumentEditor {
			if (value === 'profile') return 'buildMode';
			if (value === 'buildMode' || value === 'code' || value === 'academy') return value;
			throw new TypeError(
				localize(
					'editor.selection.invalid',
					'Default new document editor must be buildMode, code, or academy; received {0}.',
					String(value),
				),
			);
		},
		setting: {
			valueType: 'select',
			get title() {
				return localize('editor.selection.title', 'Default editor for new documents');
			},
			get description() {
				return localize(
					'editor.selection.description',
					'Use the default editor, or prefer Code or Academy for new untitled documents.',
				);
			},
			options: [
				{ value: 'buildMode', label: 'Default' },
				{ value: 'code', label: 'Code' },
				{ value: 'academy', label: 'Academy' },
			],
		},
	}),
});
