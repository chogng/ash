import { commands, ExtensionError } from '@ash/extension';
import { label } from './helper.js';
let deactivated = false;
let captured;
export function activate(context) {
    context.subscriptions.push({ dispose() { if (!deactivated) { throw new Error('deactivate must precede subscription disposal'); } } });
    for (const [id, callback] of [
        ['inspect', async ({ workspace, window }, uri, path) => {
            const editor = await workspace.openTextDocument(uri);
            const disk = await workspace.readTextFile(path);
            await window.showInformationMessage(label);
            return { editor: editor.getText(), version: editor.version, disk, frozen: Object.isFrozen(editor) };
        }],
        ['globals', () => [typeof require, typeof process, typeof fetch, typeof Electron]],
        ['echo', (_, value) => value],
        ['fail', () => { throw new Error('callback failed'); }],
        ['read', ({ workspace }, path) => workspace.readTextFile(path)],
        ['readFailure', async ({ workspace }) => { try { await workspace.readTextFile('../outside'); } catch (error) { return { typed: error instanceof ExtensionError, code: error.code }; } }],
        ['capture', context => { captured = context; return null; }],
        ['retired', () => captured.workspace.readTextFile('data.txt')],
        ['spin', () => { while (true) {} }],
        ['heap', () => { const values = []; while (true) { values.push(new Array(4096).fill('retained')); } }],
        ['pick', ({ window }) => window.showQuickPick(['first', 'second'], 'Choose')],
        ['continuationSpin', async () => { await Promise.resolve(); while (true) {} }],
        ['rejectionSpin', () => { throw { toString() { while (true) {} } }; }],
        ['wait', () => new Promise(() => {})],
        ['forge', () => globalThis.__ashRequest(3, JSON.stringify({ operation: 'executeCommand', command: 'danger', arguments: [] }))],
    ]) { context.subscriptions.push(commands.registerCommand(`example.${id}`, id, callback)); }
}
export function deactivate() { deactivated = true; }
