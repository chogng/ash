import type { IExtensionService } from '../../../common/extensionService.js';
import { editor, languages } from '../../../../../../editor/editor.api.js';
import '../../../../../../editor/editor.code.all.js';
import { MainThreadClientEditors } from '../../../../../api/browser/mainThreadClientEditors.js';
import { EditorExtensionsRegistry } from '../../../../../../editor/browser/editorExtensions.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { Range } from '../../../../../../editor/common/core/range.js';
import type { IExtensionApi } from '../../../../../../platform/extensions/common/extensionApi.js';
import type { IExtensionHostApi } from '../../../../../../platform/agentHost/common/extensionHostApi.js';

const language = languages.registerLanguages([{ description: { id: 'code-fixture' } }]);
const languageConfiguration = languages.setLanguageConfiguration('code-fixture', { brackets: [['(', ')']], autoClosingPairs: [{ open: '(', close: ')' }] });
const widget = editor.create(document.getElementById('editor')!, { value: '', language: 'code-fixture', placeholder: 'Write here', minimap: { enabled: true } });
const model = widget.getModel()!;
let backendRequests = 0;
const emptyEditorDeclarations = { getExtensionPointContributions: () => [] } as unknown as IExtensionService;
const bridge = new MainThreadClientEditors(30_000, async () => { throw new Error('Unexpected extension module load'); }, {
	invoke: async () => { backendRequests++; throw new Error('Unexpected backend request'); },
} as unknown as IExtensionHostApi, { list: async () => ({ generation: 1, extensions: [], diagnostics: [] }) } as unknown as IExtensionApi, emptyEditorDeclarations);
const state = () => ({
	ids: EditorExtensionsRegistry.getEditorContributions().map(value => value.id),
	text: model.getValue(), version: model.getVersionId(), modelId: model.id, backendRequests,
	minimap: !!document.querySelector('.minimap'),
	rename: CommandsRegistry.hasCommand('editor.action.rename'),
	placeholder: !!document.querySelector('.stanza-editor-placeholder-text'),
	folding: !!widget.getContribution('editor.contrib.folding'),
});
let generation = 0;
const api = {
	state,
	async reconnect() {
		bridge.clear();
		await bridge.update({ generation: ++generation, extensions: [] });
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
