import { commands, languages } from '@ash/extension';
export function activate(context) {
    const hover = languages.registerHoverProvider('example.hover', ['typescript'], {
        async provideHover(call, document, position) {
            if (document.getText() === 'pending') { return new Promise(() => {}); }
            if (document.getText() === 'absent') { return undefined; }
            if (document.getText() === 'reversed') {
                return { contents: ['invalid range'], range: { start: { line: 0, character: 2 }, end: { line: 0, character: 1 } } };
            }
            const disk = await call.workspace.readTextFile('data.txt');
            return {
                contents: [JSON.stringify({ uri: document.uri, version: document.version, text: document.getText(), position, disk, frozen: Object.isFrozen(document) && Object.isFrozen(position) }), { language: 'typescript', value: 'const value = 1;' }],
                range: { start: { line: position.line, character: 0 }, end: position },
            };
        },
    });
    context.subscriptions.push(hover);
    context.subscriptions.push(commands.registerCommand('example.disposeHover', 'Dispose hover', () => { hover.dispose(); }));
}
