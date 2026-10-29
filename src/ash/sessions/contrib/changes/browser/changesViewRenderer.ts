import { h } from '../../../../base/browser/dom.js';
import type { ObjectTreeElement } from '../../../../base/browser/ui/tree/objectTreeModel.js';
import { localize } from '../../../../nls.js';
import type { ISessionFileChange } from '../../../services/sessions/common/session.js';
import { getChangesEditorFileStats } from './changesEditorLabels.js';

export interface IChangesFileItem extends ISessionFileChange {
	readonly type: 'file';
	readonly id: string;
	readonly turnNumber: number;
}

interface ChangesFolderItem {
	readonly type: 'folder';
	readonly id: string;
	readonly name: string;
}

export type ChangesTreeElement = IChangesFileItem | ChangesFolderItem;

export function isChangesFileItem(element: ChangesTreeElement): element is IChangesFileItem {
	return element.type === 'file';
}

/** Separate Turn roots keep repeated paths and different repositories independently selectable. */
export function buildTreeChildren(items: readonly IChangesFileItem[]): ObjectTreeElement<ChangesTreeElement>[] {
	const roots: ObjectTreeElement<ChangesTreeElement>[] = [];
	const folders = new Map<string, ObjectTreeElement<ChangesTreeElement>[]>();
	for (const item of items) {
		let key = `turn:${item.summary.changeSetId}`;
		if (!folders.has(key)) {
			const children: ObjectTreeElement<ChangesTreeElement>[] = [];
			folders.set(key, children);
			roots.push({
				element: { type: 'folder', id: key, name: localize('sessions.changes.turn', 'Turn {0}', item.turnNumber) },
				children,
			});
		}
		let children = folders.get(key)!;
		for (const part of item.file.path.split('/').slice(0, -1)) {
			key += `/${part}`;
			if (!folders.has(key)) {
				const nested: ObjectTreeElement<ChangesTreeElement>[] = [];
				folders.set(key, nested);
				children.push({ element: { type: 'folder', id: key, name: part }, children: nested });
			}
			children = folders.get(key)!;
		}
		children.push({ element: item });
	}
	return roots;
}

export class ChangesTreeRenderer {
	constructor(private readonly document: Document) { }

	public renderElement(row: ChangesTreeElement, reviewed: boolean, treeMode: boolean): HTMLElement {
		const element = h(this.document, 'div', { className: 'ash-sessions-change-row' });
		const label = h(this.document, 'span', { className: 'ash-sessions-change-path' });
		if (!isChangesFileItem(row)) {
			label.textContent = row.name;
			element.append(label);
			return element;
		}
		const path = row.file.previousPath ? `${row.file.previousPath} → ${row.file.path}` : row.file.path;
		label.textContent = treeMode && !row.file.previousPath ? row.file.path.split('/').at(-1)! : path;
		label.title = path;
		const counts = h(this.document, 'span');
		const statistics = getChangesEditorFileStats(row.uri, [row])!;
		counts.textContent = `+${statistics.insertions} −${statistics.deletions}`;
		const state = h(this.document, 'span', { className: 'ash-sessions-change-state' });
		state.textContent = [
			localize('sessions.changes.turn', 'Turn {0}', row.turnNumber), fileState(row),
			reviewed ? localize('sessions.changes.reviewed', 'Reviewed') : undefined,
		].filter(Boolean).join(' · ');
		state.title = [state.textContent, row.summary.failureMessage, ...row.summary.warnings].filter(Boolean).join('\n');
		element.append(label, state, counts);
		return element;
	}
}

export function fileState(row: IChangesFileItem): string {
	const summary = row.summary;
	if (summary.committedPaths.includes(row.file.path)) { return localize('sessions.changes.fileCommitted', 'Committed'); }
	if (summary.captureState !== 'sealed') { return localize('sessions.changes.fileUnsealed', 'Not sealed'); }
	switch (summary.commitState) {
		case 'queued': return localize('sessions.changes.fileQueued', 'Queued');
		case 'committing': return localize('sessions.changes.fileCommitting', 'Committing');
		case 'conflict': return localize('sessions.changes.fileConflict', 'Conflict — preview again after resolving');
		case 'failed': return localize('sessions.changes.fileFailed', 'Commit failed: {0}', summary.failureMessage ?? '');
		case 'idle': case 'partiallyCommitted': case 'committed': return localize('sessions.changes.fileRemaining', 'Not committed');
	}
}
