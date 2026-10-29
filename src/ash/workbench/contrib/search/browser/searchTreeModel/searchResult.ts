import { basename, extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { Range } from '../../../../../editor/common/core/range.js';
import type { ContentSearchMatch } from '../../../../../platform/search/common/search.js';
import type { IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import type { IFileMatch } from '../../../../services/search/common/search.js';

export interface SearchFolderMatch {
	readonly kind: 'folder';
	readonly id: string;
	readonly resource: URI;
	readonly name: string;
	readonly children: Map<string, SearchFolderMatch | SearchFileMatch>;
}

export interface SearchFileMatch {
	readonly kind: 'file';
	readonly id: string;
	readonly resource: URI;
	readonly name: string;
	readonly path: string;
	readonly folder: IWorkspaceFolder | undefined;
	readonly matches: SearchMatch[];
}

export interface SearchMatch {
	readonly kind: 'match';
	readonly id: string;
	readonly file: SearchFileMatch;
	readonly preview: string;
	readonly previewRange: ContentSearchMatch['ranges'][number];
	readonly range: Range;
}

export type RenderableMatch = SearchFolderMatch | SearchFileMatch | SearchMatch;

/** Owns search data; selection, collapse state and mounted rows belong to the tree widget. */
export class SearchResultImpl {
	private readonly roots = new Map<string, SearchFolderMatch>();
	private readonly fileMatches = new Map<string, SearchFileMatch>();
	private readonly matchIds = new Set<string>();

	constructor(private readonly workspaceFolders: readonly IWorkspaceFolder[]) { }

	public get children(): readonly SearchFolderMatch[] { return [...this.roots.values()]; }
	public get files(): readonly SearchFileMatch[] { return [...this.fileMatches.values()]; }
	public get count(): number { return this.matchIds.size; }

	public addFileMatch(file: IFileMatch): void {
		const folder = [...this.workspaceFolders].sort((a, b) => b.uri.path.length - a.uri.path.length).find(folder => extUri.isEqualOrParent(file.resource, folder.uri));
		const path = folder ? file.resource.path.slice(folder.uri.path.replace(/\/$/, '').length + 1) : file.resource.path;
		for (const result of file.results ?? []) {
			for (const location of result.rangeLocations) {
				const starts = [0];
				for (const newline of result.previewText.matchAll(/\r\n|\r|\n/g)) { starts.push(newline.index + newline[0].length); }
				const offset = (line: number, column: number): number => starts[line]! + column;
				if (!folder) {
					const key = extUri.getComparisonKey(file.resource);
					let retained = this.fileMatches.get(key);
					if (!retained) {
						retained = { kind: 'file', id: `file:${key}`, resource: file.resource, name: basename(file.resource), path, folder: undefined, matches: [] };
						this.fileMatches.set(key, retained);
					}
					const source = location.source;
					const id = JSON.stringify([retained.id, source.startLineNumber, source.startColumn, source.endLineNumber, source.endColumn]);
					if (!this.matchIds.has(id)) {
						this.matchIds.add(id);
						retained.matches.push({
							kind: 'match', id, file: retained, preview: result.previewText,
							previewRange: { start: offset(location.preview.startLineNumber, location.preview.startColumn), end: offset(location.preview.endLineNumber, location.preview.endColumn) },
							range: new Range(source.startLineNumber + 1, source.startColumn + 1, source.endLineNumber + 1, source.endColumn + 1),
						});
					}
					continue;
				}
				this.add([{
					dirId: folder.id, path,
					lineNumber: location.source.startLineNumber - location.preview.startLineNumber + 1,
					preview: result.previewText,
					ranges: [{ start: offset(location.preview.startLineNumber, location.preview.startColumn), end: offset(location.preview.endLineNumber, location.preview.endColumn) }],
				}]);
			}
		}
	}

	public add(matches: readonly ContentSearchMatch[]): void {
		for (const match of matches) {
			const folder = this.workspaceFolders.find(candidate => candidate.id === match.dirId);
			if (!folder) { throw new Error('Search result does not identify a workspace folder'); }
			const path = match.path.replaceAll('\\', '/');
			const segments = path.split('/');
			const resource = URI.joinPath(folder.uri, path);
			const fileId = extUri.getComparisonKey(resource);
			let file = this.fileMatches.get(fileId);
			if (!file) {
				let parent = this.roots.get(folder.id);
				if (!parent) {
					parent = {
						kind: 'folder',
						id: `folder:${extUri.getComparisonKey(folder.uri)}`,
						resource: folder.uri,
						name: folder.name,
						children: new Map(),
					};
					this.roots.set(folder.id, parent);
				}
				for (const segment of segments.slice(0, -1)) {
					const childResource: URI = URI.joinPath(parent.resource, segment);
					const id: string = `folder:${extUri.getComparisonKey(childResource)}`;
					let child = parent.children.get(id) as SearchFolderMatch | undefined;
					if (!child) {
						child = { kind: 'folder', id, resource: childResource, name: segment, children: new Map() };
						parent.children.set(id, child);
					}
					parent = child;
				}
				file = {
					kind: 'file',
					id: `file:${fileId}`,
					resource,
					name: segments.at(-1)!,
					path,
					folder,
					matches: [],
				};
				parent.children.set(file.id, file);
				this.fileMatches.set(fileId, file);
			}
			for (const range of match.ranges) {
				const id = JSON.stringify([file.id, match.lineNumber, range.start, range.end]);
				if (this.matchIds.has(id)) { continue; }
				this.matchIds.add(id);
				// Offsets cover the complete preview block, including CRLF and surrogate pairs.
				const start = match.preview.slice(0, range.start).split(/\r\n|\r|\n/);
				const end = match.preview.slice(0, range.end).split(/\r\n|\r|\n/);
				file.matches.push({
					kind: 'match',
					id,
					file,
					preview: match.preview,
					previewRange: range,
					range: new Range(match.lineNumber + start.length - 1, start.at(-1)!.length + 1, match.lineNumber + end.length - 1, end.at(-1)!.length + 1),
				});
			}
		}
	}

	public clear(): void {
		this.roots.clear();
		this.fileMatches.clear();
		this.matchIds.clear();
	}

	/** Dismisses retained results; later batches may add the same matches again. */
	public batchRemove(elementsToRemove: RenderableMatch[]): void {
		const selected = new Set(elementsToRemove);
		const prune = (folder: SearchFolderMatch, removeChildren: boolean): void => {
			for (const [id, child] of folder.children) {
				if (child.kind === 'folder') {
					prune(child, removeChildren || selected.has(child));
					if (!child.children.size) { folder.children.delete(id); }
					continue;
				}
				const removeFile = removeChildren || selected.has(child);
				if (removeFile) {
					// Detach whole files from the active owner without destroying explicit command arguments.
					for (const match of child.matches) { this.matchIds.delete(match.id); }
					folder.children.delete(id);
					this.fileMatches.delete(extUri.getComparisonKey(child.resource));
					continue;
				}
				for (let index = child.matches.length - 1; index >= 0; index--) {
					const match = child.matches[index]!;
					if (selected.has(match)) {
						this.matchIds.delete(match.id);
						child.matches.splice(index, 1);
					}
				}
				if (!child.matches.length) {
					folder.children.delete(id);
					this.fileMatches.delete(extUri.getComparisonKey(child.resource));
				}
			}
		};
		for (const [id, root] of this.roots) {
			prune(root, selected.has(root));
			if (!root.children.size) { this.roots.delete(id); }
		}
		for (const [key, file] of this.fileMatches) {
			if (file.folder) { continue; }
			if (selected.has(file)) {
				for (const match of file.matches) { this.matchIds.delete(match.id); }
				this.fileMatches.delete(key);
				continue;
			}
			for (let index = file.matches.length - 1; index >= 0; index--) {
				if (selected.has(file.matches[index]!)) {
					this.matchIds.delete(file.matches[index]!.id);
					file.matches.splice(index, 1);
				}
			}
			if (!file.matches.length) { this.fileMatches.delete(key); }
		}
	}
}
