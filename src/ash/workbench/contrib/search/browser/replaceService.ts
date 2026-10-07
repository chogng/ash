import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { extUri } from '../../../../base/common/resources.js';
import type { IContentSearchQuery } from '../../../../platform/search/common/search.js';
import { IBulkEditService, WorkspaceEditConflictError } from '../../../../editor/browser/services/bulkEditService.js';
import type { LanguageTextDocumentEdit } from '../../../../editor/common/languages.js';
import { parseReplaceString, ReplacePattern } from '../../../../editor/contrib/find/browser/replacePattern.js';
import { ITextModelResourceService, type TextModelReference } from '../../../services/textmodelResolver/common/textModelResourceService.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { localize } from '../../../../nls.js';
import { IReplaceService, type SearchReplaceResult } from './replace.js';
import type { SearchMatch } from './searchTreeModel/searchResult.js';

/** Builds versioned edits from the searched snapshot and delegates mutation, preview and undo. */
export class ReplaceService implements IReplaceService {
	constructor(
		@ITextModelResourceService private readonly models: ITextModelResourceService,
		@IBulkEditService private readonly bulkEdits: IBulkEditService,
		@IWorkingCopyService private readonly workingCopies: IWorkingCopyService,
	) { }

	public async replace(matches: readonly SearchMatch[], query: IContentSearchQuery, replacement: string, options: { readonly preview: boolean; readonly preserveCase: boolean; readonly signal: AbortSignal; }): Promise<SearchReplaceResult> {
		using references = new DisposableStore();
		const grouped = new Map<string, SearchMatch[]>();
		for (const match of matches) {
			const key = extUri.getComparisonKey(match.file.resource);
			const entries = grouped.get(key);
			if (entries) { entries.push(match); } else { grouped.set(key, [match]); }
		}
		const pattern = query.patternKind === 'regex' ? parseReplaceString(replacement) : ReplacePattern.fromStaticValue(replacement);
		const sensitive = query.caseSensitivity === 'sensitive' || query.caseSensitivity === 'smart' && /\p{Lu}/u.test(query.text);
		const expression = query.patternKind === 'regex'
			? new RegExp(query.text.replace(/\r\n|\r/g, '\n').replaceAll('\n', '\\r?\\n'), sensitive ? 'gmu' : 'gmiu')
			: undefined;
		const edits: LanguageTextDocumentEdit[] = [];
		const acquired: TextModelReference[] = [];
		for (const entries of grouped.values()) {
			throwIfCancelled(options.signal);
			const resource = entries[0]!.file.resource;
			const reference = references.add(await this.models.acquire({ resource }, options.signal));
			acquired.push(reference);
			const textEdits = entries.map(match => {
				const expected = match.preview.slice(match.previewRange.start, match.previewRange.end).replace(/\r\n|\r/g, '\n');
				// Search previews can normalize line endings while the shared model retains the file's EOL.
				if (!reference.model.isValidRange(match.range) || reference.model.getTextInRange(match.range).replace(/\r\n|\r/g, '\n') !== expected) {
					throw new WorkspaceEditConflictError(localize('search.replaceStale', '{0} changed after the search. Refresh the results before replacing.', match.file.path));
				}
				let captures: string[] = [expected];
				if (expression) {
					expression.lastIndex = match.previewRange.start;
					const found = expression.exec(match.preview);
					if (!found || found.index !== match.previewRange.start || found[0].length !== match.previewRange.end - match.previewRange.start) {
						throw new WorkspaceEditConflictError(localize('search.replacePatternChanged', 'The search expression no longer matches the selected result. Refresh the results before replacing.'));
					}
					captures = found;
				}
				return { range: match.range, text: pattern.buildReplaceString(captures, options.preserveCase) };
			});
			edits.push({ kind: 'textDocument', resource, version: reference.model.version, expectedText: reference.model.getText(), edits: textEdits });
		}
		const result = await this.bulkEdits.apply({ entries: edits }, {
			token: options.signal,
			showPreview: options.preview,
			label: localize('search.replaceLabel', 'Replace search results'),
		});
		const saveErrors: string[] = [];
		if (result.isApplied) {
			// Search replacement saves affected working copies; shared models preserve unrelated dirty edits.
			const affected = new Set(result.resources.map(resource => extUri.getComparisonKey(resource)));
			for (const reference of acquired) {
				// Bulk edits already save closed files. Open working copies need the
				// Search command's save step, and retain dirty text if that save fails.
				if (!affected.has(extUri.getComparisonKey(reference.resource)) || !this.workingCopies.get(reference.resource).length) { continue; }
				try { await reference.save(options.signal); } catch (error) { saveErrors.push(error instanceof Error ? error.message : String(error)); }
			}
		}
		if (!result.isApplied) { return { ...result, saveErrors }; }
		return {
			...result,
			saveErrors,
			undo: async () => {
				await result.undo();
				for (const resource of result.resources) {
					if (!this.workingCopies.get(resource).length) { continue; }
					using reference = await this.models.acquire({ resource }, new AbortController().signal);
					await reference.save(new AbortController().signal);
				}
			},
		};
	}
}
