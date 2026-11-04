import { getWindow } from '../../../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../../../base/common/async.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../../../../../base/common/lifecycle.js';
import { EditorOption } from '../../../../../../editor/common/config/editorOptions.js';
import type { IChatInputEditor } from './chatInputEditorRegistry.js';
import './chatInputLayout.css';

/** Shares the composer layout between new messages and in-place edits. */
export function installChatInputLayout(container: HTMLElement, input: IChatInputEditor, actions: HTMLElement, attachments?: HTMLElement, layoutMode: 'adaptive' | 'stacked' = 'adaptive'): IDisposable {
	const store = new DisposableStore();
	container.classList.add('ash-chat-input-adaptive');
	if (layoutMode === 'stacked') container.classList.add('expanded');
	actions.classList.add('ash-chat-input-inline-toolbar');
	attachments?.classList.add('ash-chat-input-inline-toolbar', 'ash-chat-input-attachment-toolbar');

	const fitsOnSingleLine = input.fitsOnSingleLine?.bind(input);
	if (!fitsOnSingleLine) return store;
	const layout = store.add(new RunOnceScheduler(() => {
		if (container.clientWidth === 0) return;
		const style = getWindow(container).getComputedStyle(container);
		// Measure the space next to the controls even while they sit on the next row.
		const gap = parseFloat(style.rowGap);
		const rightPadding = parseFloat(style.paddingRight);
		const compactWidth = container.clientWidth - parseFloat(style.paddingLeft) - rightPadding
			- actions.offsetWidth - gap - (attachments ? attachments.offsetWidth + gap : 0);
		const expanded = layoutMode === 'stacked' || !fitsOnSingleLine(compactWidth);
		const changed = expanded !== container.classList.contains('expanded');
		container.classList.toggle('expanded', expanded);
		const editorChanged = input.setCompactLayout?.(!expanded, rightPadding);
		if (changed || editorChanged) input.layout();
	}, 0));
	const schedule = (): void => layout.schedule();
	store.add(input.onDidChange(schedule));
	if (input.codeEditor) {
		store.add(input.codeEditor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.fontInfo)) schedule();
		}));
		store.add(input.codeEditor.onDidChangeModelDecorations(schedule));
	}
	const observer = new ResizeObserver(schedule);
	store.add(toDisposable(() => observer.disconnect()));
	observer.observe(container);
	observer.observe(actions);
	if (attachments) observer.observe(attachments);
	schedule();
	return store;
}
