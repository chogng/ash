import { editors } from 'ash';
import { commands } from 'vscode';
import { URI, type IResourceEditorInput, type EditorOpenOptions, type EditorOpenTarget } from '../../../sdk/browser/index.js';
export interface CommandClient { executeCommand<T = unknown>(command: string, ...args: readonly unknown[]): Promise<T>; }
export interface DialogClient { confirm(options: { title?: string; message: string; detail?: string; primaryButton?: string; }): Promise<{ confirmed: boolean; }>; }
export interface EditorClient { openEditor(input: IResourceEditorInput, options?: EditorOpenOptions, target?: EditorOpenTarget): Promise<unknown>; }
export interface ViewsClient { focusView(id: string): Promise<unknown>; openView(id: string, focus?: boolean): Promise<unknown>; }
export interface WorkingCopyClient { get(uri: URI): Promise<readonly { isDirty: boolean; }[]> | readonly { isDirty: boolean; }[]; }
export const commandClient: CommandClient = { executeCommand: async <T>(command: string, ...args: readonly unknown[]) => await commands.executeCommand<T>(command, ...args.map(value => value === undefined ? null : encode(value))) as T };
export const dialogClient: DialogClient = { confirm: options => editors.request({ method: 'confirm', ...options }) };
export const editorClient: EditorClient = { openEditor: (input, options, target) => editors.request({ method: 'open', input: encode(input), options, sideBySide: target === 'sideGroup' }) };
export const viewsClient: ViewsClient = { focusView: id => editors.request({ method: 'openView', id, focus: true }), openView: (id, focus) => editors.request({ method: 'openView', id, focus }) };
export const workingCopyClient: WorkingCopyClient = { get: uri => editors.request({ method: 'dirty', uri: uri.toString() }) };
function encode(value: unknown): unknown { return JSON.parse(JSON.stringify(value, function (key, entry) { const original = this[key]; return original instanceof URI ? original.toString() : original instanceof Uint8Array ? Array.from(original) : entry; })); }
export async function input(options: { title?: string; placeHolder?: string; value?: string; validateInput?(value: string): Promise<string | undefined>; }): Promise<string | undefined> {
	let value = options.value;
	let validationMessage: string | undefined;
	for (; ;) {
		const result = await editors.request<string | null>({ method: 'input', title: options.title, placeHolder: options.placeHolder, value, validationMessage });
		if (result === null) { return undefined; }
		const error = await options.validateInput?.(result);
		if (!error) { return result; }
		validationMessage = error;
		value = result;
	}
}
