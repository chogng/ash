import { Marked } from '../../../app-ts/src/ash/base/common/marked/marked.js';
import manifest from '../package.json';
import english from '../package.nls.json';
import chinese from '../package.nls.zh-CN.json';
import previewStyle from '../media/markdown.css?raw';

const parser = new Marked({ gfm: true, renderer: { html: () => '' } });
const preview = manifest.contributes.customEditors[0];

/** Executed by the browser Extension Host Worker, with no access to Workbench DOM. */
export function activate(context) {
	const messages = context.language === 'zh-CN' ? chinese : english;
	const label = value => value.replace(/^%(.+)%$/, (_, key) => messages[key]);
	for (const command of manifest.contributes.commands) {
		const menus = Object.entries(manifest.contributes.menus).flatMap(([menu, entries]) => entries
			.filter(entry => entry.command === command.command).map(({ command: _command, ...entry }) => ({ menu, ...entry })));
		context.register({
			kind: 'command', registrationId: command.command, command: command.command,
			title: label(command.title), icon: command.icon.slice(2, -1), menus
		}, async (_operation, payload) => {
			const editor = payload.activeEditor;
			if (!editor) {
				return null;
			}
			if (command.command === 'markdown.showPreviewToSide') {
				await context.executeCommand('_workbench.openWith', editor.resource, preview.viewType, [-2], editor.groupId);
			} else if (command.command === 'markdown.showPreview') {
				await context.executeCommand('_workbench.openWith', editor.resource, preview.viewType, [-1], editor.groupId);
			} else if (command.command === 'markdown.showSource') {
				await context.executeCommand('_workbench.openWith', editor.resource, 'default', [-1], editor.groupId);
			} else {
				const source = command.command === 'markdown.reopenAsSource';
				await context.executeCommand('reopenActiveEditorWith', source ? 'default' : preview.viewType, { groupId: editor.groupId, editorIndex: editor.editorIndex });
			}
			return null;
		});
	}
	context.register({
		kind: 'customTextEditor', registrationId: preview.viewType, viewType: preview.viewType,
		displayName: label(preview.displayName), priority: preview.priority, selectors: preview.selector.map(selector => selector.filenamePattern), languageIds: ['markdown']
	},
		async (_operation, payload, signal) => {
			signal.throwIfAborted();
			const content = parser.parse(payload.document.text);
			return {
				html: `<style>${previewStyle}</style><main>${content}</main><script>
			const api = acquireAshWebviewApi();
			document.addEventListener('click', event => {
				const anchor = event.target.closest('a');
				if (anchor) { event.preventDefault(); api.postMessage({ href: anchor.getAttribute('href') }); }
			});
			</script>` };
		});
}
