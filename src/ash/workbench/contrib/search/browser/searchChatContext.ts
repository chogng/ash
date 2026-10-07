import { basename, extUri } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { FileKind, IFileService } from '../../../../platform/files/common/files.js';
import { IFileSearchService } from '../../../../platform/search/common/fileSearch.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import type { ChatContextAttachment } from '../../../services/chat/common/chatContextService.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';

/** Captures resource context when selected so draft handoff and submission use the same snapshot. */
export class FilesAndFoldersPickerPick {
	constructor(
		@IFileService private readonly files: IFileService,
		@IWorkingCopyService private readonly workingCopies: IWorkingCopyService,
		@IFileSearchService private readonly search: IFileSearchService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) { }

	public async asAttachment(resource: URI, kind: FileKind, signal: AbortSignal): Promise<ChatContextAttachment> {
		const name = basename(resource) || resource.path;
		let content: string;
		if (kind === FileKind.Directory) {
			const folder = this.workspace.getWorkspace().folders.find(folder => extUri.isEqualOrParent(resource, folder.uri));
			if (!folder) throw new Error(localize('chat.context.folderUnavailable', 'The folder is outside the current workspace'));
			const relative = resource.path.slice(folder.uri.path.replace(/\/$/, '').length).replace(/^\//, '');
			const prefix = relative ? `${relative}/` : '';
			const found = await this.search.glob({ resource: folder.uri, target: { type: 'workspace', dirId: folder.id } }, { includePatterns: prefix ? [`${prefix.replace(/[\\*?{}[\]]/g, '\\$&')}**`] : [], excludePatterns: [], maxResults: 1000 }, signal);
			// The current Turn contract accepts text context. A directory carries its scope and a bounded manifest, not copies of every file.
			content = `Directory: ${resource.toString()}\nFiles:\n${found.matches.map(file => file.path.slice(prefix.length)).join('\n')}`;
			if (found.totalMatches > found.matches.length) content += `\n… (${found.totalMatches - found.matches.length} additional files)`;
		} else {
			const copy = this.workingCopies.get(resource).find(candidate => candidate.backupKind === 'text');
			content = copy ? copy.backup() : (await this.files.readFile(resource)).content;
			if (content.includes('\0') || !content.trim()) throw new Error(localize('chat.context.invalidText', '{0} must contain nonempty UTF-8 text', name));
		}
		return { id: `file:${extUri.getComparisonKey(resource)}`, kind: kind === FileKind.Directory ? 'directory' : 'file', name, resolve: async () => ({ name, content }) };
	}
}
