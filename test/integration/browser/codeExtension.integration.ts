import { editor, languages } from '../../../src/ash/editor/editor.api.js';
import '../../../src/ash/editor/editor.all.js';
import { MainThreadClientEditors } from '../../../src/ash/workbench/api/browser/mainThreadClientEditors.js';
import { loadExtensionEditorModule } from '../../../src/ash/workbench/services/extensions/browser/extensionEditorModules.js';
import { EditorExtensionsRegistry } from '../../../src/ash/editor/browser/editorExtensions.js';
import { CommandsRegistry } from '../../../src/ash/platform/commands/common/commands.js';
import { Range } from '../../../src/ash/editor/common/core/range.js';
import type { IExtensionApi, ExtensionDescriptor } from '../../../src/ash/platform/extensions/common/extensionApi.js';
import type { IExtensionHostApi, ExtensionHostFleetSnapshot } from '../../../src/ash/platform/agentHost/common/extensionHostApi.js';
import manifest from '../../../extensions/code/package.json' with { type: 'json' };

const owner = { id: 'ash.code', name: 'code', publisher: 'ash', version: '1.0.0', sourceKind: 'builtIn', packageSha256: 'b'.repeat(64), manifestJson: JSON.stringify(manifest) } as ExtensionDescriptor;
const language = languages.registerLanguages([{ description: { id: 'code-fixture' } }]);
const languageConfiguration = languages.setLanguageConfiguration('code-fixture', { brackets: [['(', ')']], autoClosingPairs: [{ open: '(', close: ')' }] });
const widget = editor.create(document.getElementById('editor')!, { value: '', language: 'code-fixture', placeholder: 'Write here', minimap: { enabled: true } });
const model = widget.getModel()!;
const bridge = new MainThreadClientEditors(30_000, loadExtensionEditorModule, {
	invoke: async (request, signal) => {
		const response = await fetch('/__code_invoke', { method: 'POST', body: JSON.stringify(request.payload), signal });
		if (!response.ok) throw new Error(await response.text());
		return response.json();
	},
} as IExtensionHostApi, { list: async () => ({ generation: 1, extensions: [owner], diagnostics: [] }) } as unknown as IExtensionApi);
const state = () => ({
	ids: EditorExtensionsRegistry.getEditorContributions().map(value => value.id),
	text: model.getValue(), version: model.getVersionId(), modelId: model.id,
	minimap: !!document.querySelector('.minimap'),
	rename: CommandsRegistry.hasCommand('editor.action.rename'),
	placeholder: !!document.querySelector('.stanza-editor-placeholder-text'),
	folding: !!widget.getContribution('editor.contrib.folding'),
});
const api = {
	state,
	async enable(enabled: boolean) {
		const response = await fetch('/__code_extension', { method: 'POST', body: JSON.stringify({ enabled }) });
		if (!response.ok) throw new Error(await response.text());
		await bridge.update(await response.json() as ExtensionHostFleetSnapshot);
		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		return state();
	},
	type(text: string) { widget.trigger('keyboard', 'type', { text }); return state(); },
	edit(text: string) { widget.executeEdits('test', [{ range: new Range(1, 1, 1, 1), text }]); return state(); },
	undo() { model.undo(); return state(); },
	dispose() { bridge.dispose(); widget.dispose(); model.dispose(); languageConfiguration.dispose(); language.dispose(); },
};
declare global { interface Window { ashCodeExtension: typeof api; } }
window.ashCodeExtension = api;
