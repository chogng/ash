import { Disposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IFileService } from '../../../../platform/files/common/files.js';
import type { IEditorService } from '../../../services/editor/common/editorService.js';
import type { ChatContextAttachment, ChatContextPick, IChatContextPickService } from '../../../services/chat/common/chatContextService.js';

const MaxFileCharacters = 32 * 1024;

/** Makes open local files available as explicit Chat context. */
export class ChatFileContextContribution extends Disposable {
	constructor(contextPickService: IChatContextPickService, editorService: IEditorService, fileService: IFileService) {
		super();
		this._register(contextPickService.registerPicker({
			id: 'chat.files',
			label: 'Open files',
			isEnabled: () => editorService.visibleEditors.some(editor => editor.resource.scheme === 'file'),
			providePicks: async query => filePicks(editorService, fileService, query),
		}));
	}
}

function filePicks(editorService: IEditorService, fileService: IFileService, query: string): readonly ChatContextPick[] {
	const search = query.trim().toLocaleLowerCase();
	const seen = new Set<string>();
	return editorService.visibleEditors
		.filter(editor => editor.resource.scheme === 'file')
		.filter(editor => {
			const key = editor.resource.toString();
			if (seen.has(key)) return false;
			seen.add(key);
			if (!search) return true;
			return (editor.label ?? editor.resource.fsPath).toLocaleLowerCase().includes(search)
				|| editor.resource.fsPath.toLocaleLowerCase().includes(search);
		})
		.map(editor => ({
			label: editor.label ?? editor.resource.fsPath,
			description: editor.resource.fsPath,
			attachment: fileAttachment(fileService, editor.resource),
		}));
}

function fileAttachment(fileService: IFileService, resource: URI): ChatContextAttachment {
	return {
		id: resource.toString(),
		kind: 'file',
		name: resource.fsPath,
		resolve: async () => {
			const { content } = await fileService.readFile(resource);
			return {
				name: `File ${resource.fsPath}`,
				content: content.length > MaxFileCharacters
					? `${content.slice(0, MaxFileCharacters)}\n[File truncated]`
					: content || '[Empty file]',
				filePath: resource.fsPath,
			};
		},
	};
}
