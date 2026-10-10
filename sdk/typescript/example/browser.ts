import { commands, defineBrowserExtension, languages, throwIfCancelled, window } from '../browser.js';

export const { activate, deactivate } = defineBrowserExtension(context => {
	context.subscriptions.push(commands.registerCommand('example.openSource', 'Open source', async call => {
		if (call.activeEditor) await call.commands.executeCommand('reopenActiveEditorWith', 'default', { groupId: call.activeEditor.groupId, editorIndex: call.activeEditor.editorIndex });
	}));
	context.subscriptions.push(languages.registerLanguageProvider('example.symbols', ['markdown'], {
		operations: ['documentSymbols'],
		provideLanguageFeatures(call, request) {
			throwIfCancelled(call.cancellationToken);
			if (request.operation !== 'documentSymbols') return null;
			return [{ name: request.document.getText(), kind: 15, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, children: [] }];
		},
	}));
	context.subscriptions.push(window.registerCustomTextEditorProvider('example.preview', {
		resolveCustomTextEditor(call) {
			throwIfCancelled(call.cancellationToken);
			return { html: '<main>Preview</main>' };
		},
	}, { displayName: 'Example preview', priority: 'option', selectors: ['*.md'] }));
});
