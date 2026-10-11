import { toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';

/** Attach a directly owned child and remove it with its owner. */
export function appendRemoveOnDispose(parent: HTMLElement, child: HTMLElement): IDisposable {
	parent.append(child);
	return toDisposable(() => child.remove());
}
