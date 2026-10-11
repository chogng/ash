import { registerLanguageFeatures } from './languageFeatures.js';
import * as vscode from 'vscode';
import { Marked } from 'marked';
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
	const messages = vscode.env.language === 'zh-CN' ? chinese : english;
	for (const command of manifest.contributes.commands) {
		context.subscriptions.push(vscode.commands.registerCommand(command.command, async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				return null;
			}
			if (command.command === 'markdown.showPreviewToSide') {
				await vscode.commands.executeCommand('vscode.openWith', editor.document.uri, preview.viewType, { viewColumn: -2 });
			} else if (command.command === 'markdown.showPreview') {
				await vscode.commands.executeCommand('vscode.openWith', editor.document.uri, preview.viewType, { viewColumn: -1 });
			} else if (command.command === 'markdown.showSource') {
				await vscode.commands.executeCommand('vscode.openWith', editor.document.uri, 'default', { viewColumn: -1 });
			} else if (command.command === 'markdown.showRichEditor') {
				await vscode.commands.executeCommand('vscode.openWith', editor.document.uri, 'vscode.markdown.editor', { viewColumn: -1 });
			} else {
				const source = command.command === 'markdown.reopenAsSource';
				const viewType = command.command === 'markdown.reopenAsRichEditor' ? 'vscode.markdown.editor' : preview.viewType;
				await vscode.commands.executeCommand('reopenActiveEditorWith', source ? 'default' : viewType);
			}
			return null;
		}));
	}
	context.subscriptions.push(vscode.window.registerCustomEditorProvider(preview.viewType, {
		async resolveCustomTextEditor(document, panel, token) {
			if (token.isCancellationRequested) return;
			panel.webview.html = `<style>${previewStyle}</style><main>${parser.parse(document.getText())}</main><script>
			const api = acquireVsCodeApi();
			document.addEventListener('click', event => {
				const anchor = event.target.closest('a');
				if (anchor) { event.preventDefault(); api.postMessage({ href: anchor.getAttribute('href') }); }
			});</script>`;
		},
	}));
	const bytes = Uint8Array.from(atob(richEditor), character => character.charCodeAt(0));
	const content = JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
	const script = vscode.Uri.parse(URL.createObjectURL(new Blob([content.script], { type: 'text/javascript' })));
	const style = vscode.Uri.parse(URL.createObjectURL(new Blob([content.style], { type: 'text/css' })));
	context.subscriptions.push({ dispose() { URL.revokeObjectURL(script.toString()); URL.revokeObjectURL(style.toString()); } });
	const rich = manifest.contributes.customEditors[1];
	const richMessages = Object.fromEntries(Object.entries(messages).filter(([key]) => key.startsWith('markdown.rich.')).map(([key, value]) => [key.slice('markdown.rich.'.length), value]));
	context.subscriptions.push(vscode.window.registerCustomEditorProvider(rich.viewType, {
		async resolveCustomTextEditor(document, panel, token) {
			if (token.isCancellationRequested) return;
			const resources = { script: panel.webview.asWebviewUri(script).toString(), style: panel.webview.asWebviewUri(style).toString() };
			const snapshot = { uri: document.uri.toString(), text: document.getText(), version: document.version, languageId: document.languageId };
			panel.webview.html = richEditorHtml(snapshot, richMessages) + `<link rel="stylesheet" href="${resources.style}"><script src="${resources.script}"></script>`;
			await panel.webview.postMessage({ type: 'document', ...snapshot });
		},
	}));
}

/** Library code is immutable package data; only the document snapshot crosses the edit boundary. */
function richEditorHtml(document, messages) {
	const initial = JSON.stringify({ ...document, messages }).replaceAll('<', '\\u003c');
	return `<script type="application/json" id="ash-markdown-initial">${initial}</script>`;
}
