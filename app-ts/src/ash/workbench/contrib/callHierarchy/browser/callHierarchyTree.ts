import { type AsyncTreeDataSource } from '../../../../base/browser/ui/tree/tree.js';
import { type LanguageHierarchyItem } from '../../../../editor/common/languages.js';
import { CallHierarchyModel, CallHierarchyDirection } from '../common/callHierarchy.js';

export class Call {
	constructor(public readonly item: LanguageHierarchyItem, public readonly model: CallHierarchyModel, public readonly parent: Call | undefined) { }
}

/** Detects cycles along the current ancestry so independent branches remain expandable. */
export class DataSource implements AsyncTreeDataSource<CallHierarchyModel, Call> {
	constructor(public getDirection: () => CallHierarchyDirection) { }

	public hasChildren(element: CallHierarchyModel | Call): boolean {
		if (element instanceof CallHierarchyModel) { return element.roots.length > 0; }
		const identity = itemIdentity(element.item);
		for (let parent = element.parent; parent; parent = parent.parent) {
			if (itemIdentity(parent.item) === identity) { return false; }
		}
		return true;
	}

	public async getChildren(element: CallHierarchyModel | Call): Promise<Call[]> {
		if (element instanceof CallHierarchyModel) {
			return element.roots.map(item => new Call(item, element, undefined));
		}
		const entries = this.getDirection() === CallHierarchyDirection.CallsFrom
			? await element.model.resolveOutgoingCalls(element.item)
			: await element.model.resolveIncomingCalls(element.item);
		const items = entries.map(entry => entry.item);
		return items.map(item => new Call(item, element.model, element));
	}
}

function itemIdentity(item: LanguageHierarchyItem): string {
	return item.resource.toString() + '\0' + item.selectionRange.startLineNumber + ':' + item.selectionRange.startColumn;
}
