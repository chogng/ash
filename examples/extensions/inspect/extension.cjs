const vscode = require('vscode');
exports.activate = context => {
	context.subscriptions.push(vscode.commands.registerCommand('ash.example.inspect', async uri => {
		const resource = uri ?? vscode.window.activeTextEditor?.document.uri;
		if (!resource) return;
		const document = await vscode.workspace.openTextDocument(typeof resource === 'string' ? vscode.Uri.parse(resource) : resource);
		await vscode.window.showInformationMessage(`Editor: ${document.getText().length} characters`);
		return { version: document.version, editor: document.getText() };
	}));
	context.subscriptions.push(vscode.languages.registerHoverProvider('plaintext', {
		provideHover(document, position) {
			return new vscode.Hover(`Version ${document.version}: ${document.getText().length} UTF-16 units at ${position.line}:${position.character}`);
		},
	}));
};
