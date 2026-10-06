import { ReferencesModel, FileReferences, OneReference } from '../referencesModel.js';
type TreeElement = FileReferences | OneReference;

export class DataSource {
	public hasChildren(element: ReferencesModel | TreeElement): boolean {
		return element instanceof ReferencesModel ? !element.isEmpty : element instanceof FileReferences;
	}
	public getChildren(element: ReferencesModel | TreeElement): TreeElement[] {
		return element instanceof ReferencesModel ? element.groups : element instanceof FileReferences ? element.children : [];
	}
}
