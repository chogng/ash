import { commands, languages, workspace, type ExtensionContext } from '@ash/extension';

export function activate(context: ExtensionContext): void {
	context.subscriptions.push(workspace.registerRemoteConnectionResolver('saved', {
		resolve(_call, authority) { return { connectionName: authority.slice('saved+'.length) }; },
	}));
	context.subscriptions.push(commands.registerCommand('ash.example.connect', 'Connect to a saved Remote target', async call => {
		const name = await call.window.showQuickPick(['build'], 'Select a saved connection name');
		if (name !== undefined) { await call.workspace.openRemoteConnection(`saved+${name}`); }
		return undefined;
	}));
	context.subscriptions.push(commands.registerCommand('ash.example.inspect', 'Inspect document and disk content', async (call, uri, path) => {
		if (typeof uri !== 'string' || typeof path !== 'string') { throw new TypeError('Expected a document URI and workspace-relative path'); }
		const document = await call.workspace.openTextDocument(uri);
		const disk = await call.workspace.readTextFile(path);
		await call.window.showInformationMessage(`Editor: ${document.getText().length} characters; disk: ${disk.length} characters`);
		return { version: document.version, editor: document.getText(), disk };
	}));
	context.subscriptions.push(languages.registerHoverProvider('ash.example.hover', ['plaintext'], {
		provideHover(_call, document, position) {
			return { contents: [`Version ${document.version}: ${document.getText().length} UTF-16 units at ${position.line}:${position.character}`] };
		},
	}));
}
