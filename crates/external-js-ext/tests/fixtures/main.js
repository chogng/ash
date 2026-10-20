const { commands, workspace, window, Uri } = require('@ash/sdk');
const { label } = require('./helper.js');
let deactivated = false;
let captured;
const read = async path => {
    const bytes = await workspace.fs.readFile(Uri.file('/workspace/' + path));
    return String.fromCharCode(...bytes);
};
exports.activate = context => {
    context.subscriptions.push({ dispose() { if (!deactivated) throw new Error('deactivate must precede subscription disposal'); } });
    for (const [id, callback] of [
        ['inspect', async (uri, path) => {
            const editor = await workspace.openTextDocument(Uri.parse(uri));
            const disk = await read(path);
            await window.showInformationMessage(label);
            return { editor: editor.getText(), version: editor.version, disk, frozen: Object.isFrozen(editor) };
        }],
        ['globals', () => [typeof require, typeof process, typeof fetch, typeof Electron]],
        ['echo', value => value],
        ['fail', () => { throw new Error('callback failed'); }],
        ['read', read],
        ['readFailure', async () => { try { await read('../outside'); } catch (error) { return { typed: error instanceof Error, code: error.code }; } }],
        ['capture', () => { captured = globalThis.__ashInvocation(); return null; }],
        ['retired', () => globalThis.__ashRequest(captured, JSON.stringify({ operation: 'readWorkspaceFile', path: 'data.txt' }))],
        ['spin', () => { while (true) {} }],
        ['heap', () => { const values = []; while (true) values.push(new Array(4096).fill('retained')); }],
        ['pick', () => window.showQuickPick(['first', 'second'], { placeHolder: 'Choose' })],
        ['continuationSpin', async () => { await Promise.resolve(); while (true) {} }],
        ['rejectionSpin', () => { throw { toString() { while (true) {} } }; }],
        ['wait', () => new Promise(() => {})],
        ['forge', () => globalThis.__ashRequest(3, JSON.stringify({ operation: 'executeCommand', command: 'danger', arguments: [] }))],
    ]) context.subscriptions.push(commands.register(`example.${id}`, callback));
};
exports.deactivate = () => { deactivated = true; };
