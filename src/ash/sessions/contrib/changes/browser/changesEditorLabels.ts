import { URI } from '../../../../base/common/uri.js';
import { extUri } from '../../../../base/common/resources.js';
import type { ISessionFileChange } from '../../../services/sessions/common/session.js';
import type { ILabelService } from '../../../../platform/label/common/label.js';

/** A read marker identifies the captured revision, including files deleted by the Turn. */
export function getChangesEditorFileResource(change: ISessionFileChange): URI {
	return change.uri;
}

/** Both sides of an individual comparison refer to the same captured file revision. */
export function findChangesEditorFileChange(resource: URI, changes: readonly ISessionFileChange[]): ISessionFileChange | undefined {
	return changes.find(change => [change.uri, change.originalUri, change.modifiedUri].some(candidate => extUri.isEqual(candidate, resource)));
}

export function getChangesEditorFileStats(resource: URI, changes: readonly ISessionFileChange[]): { readonly insertions: number; readonly deletions: number } | undefined {
	const change = findChangesEditorFileChange(resource, changes);
	return change && { insertions: change.insertions, deletions: change.deletions };
}

export interface IChangesEditorLabels {
	readonly label: string;
	readonly description: string;
}

export function getChangesEditorLabels(resource: URI, labels: Pick<ILabelService, 'getUriLabel' | 'getUriBasenameLabel' | 'getSeparator'>): IChangesEditorLabels {
	const label = labels.getUriBasenameLabel(resource);
	const fullLabel = labels.getUriLabel(resource, { relative: true });
	const separator = labels.getSeparator(resource.scheme, resource.authority);
	const lastSeparator = fullLabel.lastIndexOf(separator);
	return {
		label,
		description: lastSeparator < 0 ? (fullLabel === label ? '' : fullLabel) : fullLabel.slice(0, lastSeparator),
	};
}
