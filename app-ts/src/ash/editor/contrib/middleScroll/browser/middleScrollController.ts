import { h, addDisposableListener, getWindow } from '../../../../base/browser/dom.js';
import { scheduleAtNextAnimationFrame } from '../../../../base/browser/scheduler.js';
import { Disposable, MutableDisposable, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { ICodeEditor, IEditorMouseEvent } from '../../../browser/editorBrowser.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import type { IEditorContribution } from '../../../common/editorCommon.js';
import './middleScroll.css';

interface MiddleScrollSession {
	readonly pointerId: number;
	readonly startX: number;
	readonly startY: number;
	readonly dotDomNode: HTMLDivElement;
	x: number;
	y: number;
	lastFrame: number;
	didScroll: boolean;
}

/** Owns one editor's middle-click continuous scrolling session. */
export class MiddleScrollController extends Disposable implements IEditorContribution {
	public static readonly ID = 'editor.contrib.middleScroll';

	public static get(editor: ICodeEditor): MiddleScrollController | null {
		return editor.getContribution<MiddleScrollController>(MiddleScrollController.ID);
	}

	private readonly frame = this._register(new MutableDisposable<IDisposable>());
	private readonly domNode: HTMLElement | null;
	private session: MiddleScrollSession | undefined;

	constructor(private readonly editor: ICodeEditor) {
		super();
		this.domNode = editor.getDomNode();
		if (!this.domNode) return;
		const targetWindow = getWindow(this.domNode);
		this._register(editor.onMouseDown(event => this.handleMouseDown(event)));
		this._register(addDisposableListener<PointerEvent>(targetWindow, 'pointermove', event => this.handlePointerMove(event)));
		this._register(addDisposableListener<PointerEvent>(targetWindow, 'pointerup', event => this.handlePointerUp(event)));
		this._register(addDisposableListener<PointerEvent>(targetWindow, 'pointercancel', event => this.handlePointerCancel(event)));
		this._register(editor.onKeyDown(() => this.stop()));
		this._register(toDisposable(() => this.stop()));
	}

	private handleMouseDown(event: IEditorMouseEvent): void {
		if (!event.event.middleButton || !this.editor.getOption(EditorOption.scrollOnMiddleClick) || !this.domNode) return;
		event.event.preventDefault();
		event.event.stopPropagation();
		if (this.session) {
			this.stop();
			return;
		}
		const bounds = this.domNode.getBoundingClientRect();
		const dotDomNode = h(this.domNode.ownerDocument, 'div');
		dotDomNode.className = 'scroll-editor-on-middle-click-dot';
		dotDomNode.setAttribute('aria-hidden', 'true');
		dotDomNode.style.left = `${event.event.clientX - bounds.left}px`;
		dotDomNode.style.top = `${event.event.clientY - bounds.top}px`;
		this.domNode.append(dotDomNode);
		this.domNode.classList.add('scroll-editor-on-middle-click-editor');
		const browserEvent = event.event.browserEvent as PointerEvent;
		this.session = {
			pointerId: typeof browserEvent.pointerId === 'number' ? browserEvent.pointerId : 0,
			startX: event.event.clientX,
			startY: event.event.clientY,
			x: event.event.clientX,
			y: event.event.clientY,
			lastFrame: getWindow(this.domNode).performance.now(),
			didScroll: false,
			dotDomNode,
		};
		this.scheduleFrame();
	}

	private handlePointerMove(event: PointerEvent): void {
		if (!this.session || event.pointerId !== this.session.pointerId) return;
		this.session.x = event.clientX;
		this.session.y = event.clientY;
		if (this.domNode) this.domNode.dataset.scrollDirection = direction(this.session.x - this.session.startX, this.session.y - this.session.startY);
	}

	private handlePointerUp(event: PointerEvent): void {
		if (this.session?.pointerId === event.pointerId && this.session.didScroll) this.stop();
	}

	private handlePointerCancel(event: PointerEvent): void {
		if (this.session?.pointerId === event.pointerId) this.stop();
	}

	private scheduleFrame(): void {
		if (!this.domNode) return;
		const targetWindow = getWindow(this.domNode);
		this.frame.value = scheduleAtNextAnimationFrame(targetWindow, () => {
			this.frame.clear();
			const session = this.session;
			if (!session) return;
			if (!this.editor.getOption(EditorOption.scrollOnMiddleClick)) {
				this.stop();
				return;
			}
			const now = targetWindow.performance.now();
			const factor = Math.min(2, Math.max(0, now - session.lastFrame) / 32);
			session.lastFrame = now;
			const x = afterThreshold(session.x - session.startX);
			const y = afterThreshold(session.y - session.startY);
			if (x !== 0 || y !== 0) {
				const before = { left: this.editor.getScrollLeft(), top: this.editor.getScrollTop() };
				this.editor.setScrollPosition({ scrollLeft: before.left + x * factor, scrollTop: before.top + y * factor });
				session.didScroll ||= before.left !== this.editor.getScrollLeft() || before.top !== this.editor.getScrollTop();
			}
			this.scheduleFrame();
		});
	}

	private stop(): void {
		this.frame.clear();
		this.session?.dotDomNode.remove();
		this.session = undefined;
		this.domNode?.classList.remove('scroll-editor-on-middle-click-editor');
		if (this.domNode) delete this.domNode.dataset.scrollDirection;
	}
}

function afterThreshold(delta: number): number {
	if (Math.abs(delta) <= 5) return 0;
	return delta - Math.sign(delta) * 5;
}

function direction(x: number, y: number): string {
	const vertical = y < -5 ? 'n' : y > 5 ? 's' : '';
	const horizontal = x < -5 ? 'w' : x > 5 ? 'e' : '';
	return vertical + horizontal;
}
