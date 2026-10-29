import {
	IAccessibleViewService,
	AccessibilityVerbositySettingId,
} from '../../../../platform/accessibility/browser/accessibleView.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import {
	ContentWidgetPositionPreference,
	type ICodeEditor,
	type IContentWidget,
	type IContentWidgetPosition,
} from '../../../../editor/browser/editorBrowser.js';
import type { TextModel } from '../../../../editor/common/model/textModel.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IDebugService, type IDebugExceptionDetails } from '../common/debug.js';
import { localize } from '../../../../nls.js';
import './media/exceptionWidget.css';

/** Paused exception presentation anchored by the editor, without retaining DAP state. */
export class ExceptionWidget extends Disposable implements IContentWidget {
	readonly allowEditorOverflow = false;
	private readonly node: HTMLElement;
	private readonly heading: HTMLElement;
	private readonly details: HTMLElement;
	private position: IContentWidgetPosition | null = null;
	private generation = 0;
	private dismissed: string | undefined;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly model: TextModel,
		@IDebugService private readonly debug: IDebugService,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
	) {
		super();
		this.node = h(editor.getDomNode()!.ownerDocument, 'section');
		this.node.className = 'ash-debug-exception';
		this.node.setAttribute('role', 'region');
		this.node.setAttribute('aria-label', localize('debug.exceptionDetails', 'Debug exception details'));
		this.heading = h(this.node.ownerDocument, 'h2');
		this.details = h(this.node.ownerDocument, 'pre');
		this.details.tabIndex = 0;
		this.node.append(this.heading, this.details);
		this._register(
			addDisposableListener(this.node, 'focusin', () => {
				const hint = accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.DebugException);
				if (hint) this.node.setAttribute('aria-description', hint);
				else this.node.removeAttribute('aria-description');
			}),
		);
		this._register(
			new Button(this.node, {
				...defaultButtonStyles,
				label: localize('debug.exceptionClose', 'Close exception details'),
				size: 'small',
				onClick: () => this.close(),
			}),
		);
		this._register(
			addDisposableListener(this.node, 'keydown', event => {
				if (event.key === 'Escape') {
					event.preventDefault();
					event.stopPropagation();
					this.close();
				}
			}),
		);
		editor.addContentWidget(this);
		this._register(toDisposable(() => editor.removeContentWidget(this)));
		this._register(debug.onDidChangeSession(() => this.refresh()));
		this._register(debug.getViewModel().onDidFocusStackFrame(() => this.refresh()));
		this.refresh();
	}

	getId(): string {
		return 'debug.exceptionWidget';
	}
	getDomNode(): HTMLElement {
		return this.node;
	}
	getPosition(): IContentWidgetPosition | null {
		return this.position;
	}

	private close(): void {
		this.dismissed = this.pauseKey();
		++this.generation;
		this.position = null;
		this.editor.layoutContentWidget(this);
		this.editor.focus();
	}

	private pauseKey(): string | undefined {
		const session = this.debug.session;
		return session?.state === 'stopped' ? `${session.id}:${session.inspectionRevision}` : undefined;
	}

	private refresh(): void {
		const generation = ++this.generation;
		this.position = null;
		this.editor.layoutContentWidget(this);
		const session = this.debug.session;
		const frame = this.debug.getViewModel().focusedStackFrame;
		const key = this.pauseKey();
		if (
			!session ||
			session.state !== 'stopped' ||
			session.reason !== 'exception' ||
			!session.capabilities.supportsExceptionInfoRequest ||
			!frame ||
			frame.source?.resource?.toString() !== this.model.uri.toString() ||
			session.threadId === undefined ||
			key === this.dismissed
		)
			return;
		const current = () =>
			!this.isDisposed &&
			generation === this.generation &&
			key === this.pauseKey() &&
			this.debug.getViewModel().focusedStackFrame === frame;
		void session.exceptionInfo(session.threadId).then(
			info => {
				if (!current()) return;
				this.heading.textContent = info.exceptionId;
				this.details.textContent = [info.description, describe(info.details)]
					.filter(Boolean)
					.join('\n')
					.slice(0, 65536);
				this.details.setAttribute('aria-label', localize('debug.exceptionDetails', 'Debug exception details'));
				this.position = {
					position: { lineNumber: Math.max(1, frame.lineNumber), column: Math.max(1, frame.columnNumber) },
					preference: [ContentWidgetPositionPreference.BELOW, ContentWidgetPositionPreference.ABOVE],
				};
				this.editor.layoutContentWidget(this);
			},
			error => {
				if (!current() || isCancellationError(error)) return;
				this.heading.textContent = localize('debug.exceptionDetails', 'Debug exception details');
				this.details.textContent = error instanceof Error ? error.message : String(error);
				this.position = {
					position: { lineNumber: Math.max(1, frame.lineNumber), column: 1 },
					preference: [ContentWidgetPositionPreference.BELOW],
				};
				this.editor.layoutContentWidget(this);
			},
		);
	}
}

function describe(details: IDebugExceptionDetails | undefined): string {
	return details
		? [details.typeName, details.message, details.stackTrace, ...(details.innerException ?? []).map(describe)]
				.filter(Boolean)
				.join('\n')
		: '';
}
