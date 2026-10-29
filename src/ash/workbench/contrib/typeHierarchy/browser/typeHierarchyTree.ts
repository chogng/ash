import { type AsyncTreeDataSource } from '../../../../base/browser/ui/tree/tree.js';
import { type LanguageHierarchyItem } from '../../../../editor/common/languages.js';
import { TypeHierarchyModel, TypeHierarchyDirection } from '../common/typeHierarchy.js';

export class Type {
	constructor(public readonly item: LanguageHierarchyItem, public readonly model: TypeHierarchyModel, public readonly parent: Type | undefined) { }
}

/** Detects cycles along the current ancestry so independent branches remain expandable. */
export class DataSource implements AsyncTreeDataSource<TypeHierarchyModel, Type> {
	constructor(public getDirection: () => TypeHierarchyDirection) { }

	public hasChildren(element: TypeHierarchyModel | Type): boolean {
		if (element instanceof TypeHierarchyModel) { return element.roots.length > 0; }
		const identity = itemIdentity(element.item);
		for (let parent = element.parent; parent; parent = parent.parent) {
			if (itemIdentity(parent.item) === identity) { return false; }
		}
		return true;
	}

	public async getChildren(element: TypeHierarchyModel | Type): Promise<Type[]> {
		if (element instanceof TypeHierarchyModel) {
			return element.roots.map(item => new Type(item, element, undefined));
		}
		const items = this.getDirection() === TypeHierarchyDirection.Supertypes
			? await element.model.provideSupertypes(element.item)
			: await element.model.provideSubtypes(element.item);
		return items.map(item => new Type(item, element.model, element));
	}
}

function itemIdentity(item: LanguageHierarchyItem): string {
	return item.resource.toString() + '\0' + item.selectionRange.startLineNumber + ':' + item.selectionRange.startColumn;
}
