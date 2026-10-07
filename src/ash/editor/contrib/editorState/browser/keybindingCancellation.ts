import { CancellationTokenSource, type CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';

const requests = new WeakMap<ICodeEditor, Set<EditorKeybindingCancellationTokenSource>>();

/** Escape cancels the most recent pending operation in the focused editor. */
export class EditorKeybindingCancellationTokenSource extends CancellationTokenSource {
	private readonly listeners = new DisposableStore();

	constructor(public readonly editor: ICodeEditor, parent?: CancellationToken) {
		super(parent);
		const pending = requests.get(editor) ?? new Set<EditorKeybindingCancellationTokenSource>();
		requests.set(editor, pending);
		pending.add(this);
		this.listeners.add(toDisposable(() => {
			pending.delete(this);
			if (pending.size === 0) {
				requests.delete(editor);
			}
		}));
		this.listeners.add(editor.onKeyDown(event => {
			if (event.browserEvent.defaultPrevented || event.isComposing || event.key !== 'Escape' || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
				return;
			}
			if ([...pending].at(-1) !== this) {
				return;
			}
			event.stop();
			this.cancel();
		}));
		this.listeners.add(editor.onDidDispose(() => this.dispose(true)));
		this.listeners.add(this.token.onCancellationRequested(() => this.listeners.dispose()));
		if (parent?.isCancellationRequested) {
			this.cancel();
		}
	}

	public override dispose(cancel = false): void {
		this.listeners.dispose();
		super.dispose(cancel);
	}
}
