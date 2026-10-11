const { commands, languages, workspace, Uri } = require('vscode');
exports.activate = context => {
    const hover = languages.registerHoverProvider('typescript', {
        async provideHover(document, position) {
            if (document.getText() === 'pending') return new Promise(() => {});
            if (document.getText() === 'absent') return undefined;
            if (document.getText() === 'reversed') return { contents: ['invalid range'], range: { start: { line: 0, character: 2 }, end: { line: 0, character: 1 } } };
            const disk = String.fromCharCode(...await workspace.fs.readFile(Uri.file('/workspace/data.txt')));
            return {
                contents: [JSON.stringify({ uri: document.uri.toString(), version: document.version, text: document.getText(), position, disk, frozen: Object.isFrozen(document) && Object.isFrozen(position) }), { language: 'typescript', value: 'const value = 1;' }],
                range: { start: { line: position.line, character: 0 }, end: position },
            };
        },
    });
    context.subscriptions.push(hover, commands.registerCommand('example.disposeHover', () => hover.dispose()));
};
