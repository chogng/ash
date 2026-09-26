import { addDisposableListener, stopEvent } from '../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../base/browser/keyboardEvent.js';
import { StandardMouseEvent } from '../../../base/browser/mouseEvent.js';
import { DisposableStore, type IDisposable } from '../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../base/common/platform.js';
import type { IEditorOptions } from '../common/editor.js';

export interface IOpenEditorOptions {
	readonly editorOptions: IEditorOptions;
	readonly openToSide: boolean;
}

export function registerOpenEditorListeners(element: HTMLElement, onOpenEditor: (options: IOpenEditorOptions) => void): IDisposable {
	const listeners = new DisposableStore();
	listeners.add(addDisposableListener(element, 'click', event => {
		if (event.detail === 2) return;
		stopEvent(event);
		onOpenEditor(toOpenEditorOptions(new StandardMouseEvent(event)));
	}));
	listeners.add(addDisposableListener(element, 'dblclick', event => {
		stopEvent(event);
		onOpenEditor(toOpenEditorOptions(new StandardMouseEvent(event), true));
	}));
	listeners.add(addDisposableListener(element, 'keydown', event => {
		const options = toOpenEditorOptions(new StandardKeyboardEvent(event));
		if (!options) return;
		stopEvent(event);
		onOpenEditor(options);
	}));
	return listeners;
}

export function toOpenEditorOptions(event: StandardMouseEvent, isDoubleClick?: boolean): IOpenEditorOptions;
export function toOpenEditorOptions(event: StandardKeyboardEvent): IOpenEditorOptions | undefined;
export function toOpenEditorOptions(event: StandardMouseEvent | StandardKeyboardEvent): IOpenEditorOptions | undefined;
export function toOpenEditorOptions(event: StandardMouseEvent | StandardKeyboardEvent, isDoubleClick?: boolean): IOpenEditorOptions | undefined {
	if (event instanceof StandardKeyboardEvent) {
		if (event.isComposing || event.altGraphKey) return undefined;
		const hasModifier = event.ctrlKey || event.metaKey || event.altKey || event.shiftKey;
		const isOpenKey = event.key === 'Enter' && !hasModifier;
		const isMacOpenKey = isMacintosh && event.key === 'ArrowDown' && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
		if (isOpenKey || isMacOpenKey) {
			return {
				editorOptions: { pinned: true, preserveFocus: false },
				openToSide: false,
			};
		}
		if (event.key === ' ' && !hasModifier) {
			return {
				editorOptions: { pinned: false, preserveFocus: true },
				openToSide: false,
			};
		}
		return undefined;
	}

	return {
		editorOptions: { pinned: isDoubleClick === true || event.middleButton, preserveFocus: isDoubleClick !== true },
		openToSide: event.ctrlKey || event.metaKey || event.altKey,
	};
}
