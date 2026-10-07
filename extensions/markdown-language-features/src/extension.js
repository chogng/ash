import { registerLanguageFeatures } from './languageFeatures.js';
import { Marked } from '../../../src/ash/base/common/marked/marked.js';
import manifest from '../package.json';
import english from '../package.nls.json';
import chinese from '../package.nls.zh-CN.json';
import richEditor from './richEditor.js?webview';
import previewStyle from '../media/markdown.css?raw';

const parser = new Marked({ gfm: true, renderer: { html: () => '' } });
const preview = manifest.contributes.customEditors[0];

/** Executed by the browser Extension Host Worker, with no access to Workbench DOM. */
export async function activate(context) {
	await registerLanguageFeatures(context);
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
			} else if (command.command === 'markdown.showRichEditor') {
				await context.executeCommand('_workbench.openWith', editor.resource, 'vscode.markdown.editor', [-1], editor.groupId);
			} else {
				const source = command.command === 'markdown.reopenAsSource';
				const viewType = command.command === 'markdown.reopenAsRichEditor' ? 'vscode.markdown.editor' : preview.viewType;
				await context.executeCommand('reopenActiveEditorWith', source ? 'default' : viewType, { groupId: editor.groupId, editorIndex: editor.editorIndex });
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
	const bytes = Uint8Array.from(atob(richEditor), character => character.charCodeAt(0));
	const content = JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
	const resources = { script: context.createWebviewResource(content.script, 'text/javascript'), style: context.createWebviewResource(content.style, 'text/css') };
	const rich = manifest.contributes.customEditors[1];
	const richMessages = Object.fromEntries(Object.entries(messages).filter(([key]) => key.startsWith('markdown.rich.')).map(([key, value]) => [key.slice('markdown.rich.'.length), value]));
	context.register({
		kind: 'customTextEditor', registrationId: rich.viewType, viewType: rich.viewType,
		displayName: label(rich.displayName), priority: rich.priority,
		selectors: rich.selector.map(selector => selector.filenamePattern), languageIds: ['markdown'],
	}, async (_operation, payload, signal) => {
		signal.throwIfAborted();
		return {
			html: richEditorHtml(payload.document, richMessages),
			resources,
			update: { type: 'document', ...payload.document },
		};
	});
}

/** Library code is immutable package data; only the document snapshot crosses the edit boundary. */
function richEditorHtml(document, messages) {
	const initial = JSON.stringify({ ...document, messages }).replaceAll('<', '\\u003c');
	return `<script type="application/json" id="ash-markdown-initial">${initial}</script>`;
}
