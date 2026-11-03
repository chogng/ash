import { Schemas } from '../../../../../../base/common/network.js';
import { Range } from '../../../../../../editor/common/core/range.js';
import {
	LanguageCompletionItemKind,
	type LanguageCompletionProvider,
	type LanguageCompletionProviderRequest,
	type LanguageCompletionProviderResult,
} from '../../../../../../editor/common/languages.js';
import { FileKind, IFileService } from '../../../../../../platform/files/common/files.js';
import { IPathService } from '../../../../../../platform/path/common/pathService.js';
import { PromptFileParser } from '../promptFileParser.js';
import { getPromptFileType } from '../promptTypes.js';

/** Completes native #file references; the Markdown extension owns Markdown link completion. */
export class PromptBodyAutocompletion implements LanguageCompletionProvider {
	public readonly id = 'ash.prompt.body';
	public readonly languageIds = ['markdown'];
	public readonly triggerCharacters = [':', '/', '.'];
	private readonly parser = new PromptFileParser();

	constructor(
		@IFileService private readonly files: IFileService,
		@IPathService private readonly paths: IPathService,
	) { }

	public async provideCompletions(request: LanguageCompletionProviderRequest, signal: AbortSignal): Promise<LanguageCompletionProviderResult | undefined> {
		const resource = request.resource;
		if (signal.aborted || request.languageId !== 'markdown' || !resource || !getPromptFileType(resource)) return undefined;
		// Package reads are revision-pinned by PromptsService, not exposed as a filesystem.
		if (resource.scheme === Schemas.internal || !this.files.hasProvider(resource)) return undefined;
		const source = request.snapshot.getText().replace(/\r\n|\r/gu, '\n');
		const parsed = this.parser.parse(resource, source);
		if (parsed.header?.errors.some(error => error.code === 'unclosedHeader') || !parsed.body?.range.containsPosition(request.position)) return undefined;
		const lines = source.split('\n');
		const line = lines[request.position.lineNumber - 1];
		if (line === undefined) return undefined;
		const reference = parsed.body.fileReferences.find(reference => reference.range.containsPosition(request.position));
		if (reference?.isMarkdownLink) return undefined;
		let range = reference?.range;
		if (!range) {
			const prefix = line.slice(0, request.position.column - 1);
			const unfinished = prefix.match(/#file:(<)?([^\s`<>)]*)$/u);
			if (!unfinished) return undefined;
			const startColumn = prefix.length - unfinished[2].length + 1;
			const offset = lines.slice(0, request.position.lineNumber - 1).reduce((total, value) => total + value.length + 1, 0) + request.position.column - 1;
			// Preserve surrounding code/HTML delimiters when asking the existing parser
			// whether the unfinished destination belongs to a real Markdown reference.
			const marker = 'ashcompletioncandidate';
			const probe = this.parser.parse(resource, source.slice(0, offset) + marker + (unfinished[1] ? '>' : '') + source.slice(offset));
			if (!probe.body?.fileReferences.some(reference => !reference.isMarkdownLink
				&& reference.range.startLineNumber === request.position.lineNumber
				&& reference.range.startColumn === startColumn
				&& reference.content.includes(marker))) return undefined;
			const suffix = line.slice(request.position.column - 1).match(/^[^\s`<>)]*/u)![0];
			range = new Range(request.position.lineNumber, startColumn, request.position.lineNumber, request.position.column + suffix.length);
		}
		if (range.startLineNumber !== range.endLineNumber) return undefined;
		const typed = line.slice(range.startColumn - 1, request.position.column - 1);
		if (/[#?\\]/u.test(typed)) return undefined;
		const folder = typed.slice(0, typed.lastIndexOf('/') + 1);
		let name: string;
		try { name = decodeURIComponent(typed.slice(folder.length)); } catch { return undefined; }
		const home = this.paths.resolvedUserHome;
		const directory = parsed.body.resolveFilePath(folder || './', home?.scheme === resource.scheme && home.authority === resource.authority ? home : undefined);
		if (!directory || !this.files.hasProvider(directory)) return undefined;
		const replacement = range;
		try {
			const entries = await this.files.readDirectory(directory);
			if (signal.aborted) return undefined;
			return {
				items: entries.filter(entry => entry.name.startsWith(name) && (entry.kind === FileKind.File || entry.kind === FileKind.Directory))
					.map(entry => {
						const isDirectory = entry.kind === FileKind.Directory;
						const encoded = encodeURIComponent(entry.name).replace(/[()]/gu, value => value === '(' ? '%28' : '%29');
						const insertText = folder + encoded + (isDirectory ? '/' : '');
						return {
							id: entry.resource.toString(), label: entry.name + (isDirectory ? '/' : ''),
							insertText, filterText: insertText, range: replacement,
							kind: isDirectory ? LanguageCompletionItemKind.Folder : LanguageCompletionItemKind.File,
						};
					}),
				isIncomplete: true,
			};
		} catch {
			// A missing or unauthorized directory offers no candidate and grants no access.
			return undefined;
		}
	}
}
