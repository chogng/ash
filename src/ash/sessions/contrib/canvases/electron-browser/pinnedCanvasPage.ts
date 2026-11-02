import './media/pinnedCanvasPage.css';
import { h } from '../../../../base/browser/dom.js';
import { getCanvasReferenceKey } from '../../../../workbench/contrib/canvases/common/canvas.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, constObservable, derived } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { CanvasView } from '../../../../workbench/contrib/canvases/electron-browser/canvasView.js';
import { Menus } from '../../../browser/menus.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { IPinnedCanvasService, PINNED_CANVAS_PAGE_ID, PinnedCanvasState } from '../browser/pinnedCanvases.js';

/** Shares the live browser model with its editor; hiding the page only releases presentation. */
export class PinnedCanvasPage extends AbstractCustomView {
	readonly title;
	override readonly description;
	private view: CanvasView | undefined;

	constructor(
		@IPinnedCanvasService private readonly pins: IPinnedCanvasService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		this.title = derived(reader => pins.selected.read(reader)?.title.read(reader) ?? localize('canvas.editorName', 'Canvas'));
		this.description = derived(reader => pins.selected.read(reader)?.chatTitle.read(reader));
	}

	render(container: HTMLElement): void {
		container.classList.add('ash-pinned-canvas-page');
		this.view = this._register(this.instantiation.createInstance(CanvasView, container, container.ownerDocument.defaultView!, {
			logPrefix: '[PinnedCanvasPage]',
			notPresentableMessage: constObservable(localize('pinnedCanvasPage.unavailable', 'This Canvas is unavailable. Return to its conversation or try reconnecting.')),
			getHelpContent: () => localize('pinnedCanvasPage.help', 'This Canvas is pinned to the sidebar and stays owned by its conversation. It stays live while you work in other conversations. Tab moves through page controls. Use <keybinding:workbench.action.focusNextPart> to leave the page. The page header offers Go to Chat, Reconnect Canvas, Remove from Sidebar and Close Canvas. Removing a pin keeps the page open in its conversation. Close Canvas ends the page. Escape closes the accessible view and returns focus to the Canvas.'),
		}));
		const message = h(container.ownerDocument, 'p', { className: 'ash-pinned-canvas-message', attributes: { role: 'status' } });
		container.append(message);
		let currentKey: string | undefined;
		this._register(autorun(reader => {
			const pin = this.pins.selected.read(reader);
			const reference = pin?.reference.read(reader);
			const key = reference && getCanvasReferenceKey(reference);
			if (currentKey !== key) {
				currentKey = key;
				this.view!.setInput(pin && reference ? { reference, canvas: pin.canvas, membershipPending: pin.state.map(state => state !== PinnedCanvasState.Live) } : undefined);
			}
			message.hidden = !!reference;
			message.textContent = pin?.reconnecting.read(reader)
				? localize('pinnedCanvasPage.reconnecting', 'Waiting for the Canvas host to reconnect…')
				: localize('pinnedCanvasPage.unavailable', 'This Canvas is unavailable. Return to its conversation or try reconnecting.');
			this.view!.setVisible(!!pin);
		}));
	}
	layout(): void { this.view?.layout(); }
	override focus(): void { this.view?.focus(); }
}

export class PinnedCanvasPageContribution extends Disposable {
	constructor(@ICustomViewService views: ICustomViewService, @IPinnedCanvasService pins: IPinnedCanvasService) {
		super();
		this._register(views.registerCustomView({
			id: PINNED_CANVAS_PAGE_ID, ctor: new SyncDescriptor(PinnedCanvasPage), layout: 'fill',
			actions: { menuId: Menus.CustomViewCanvas, style: 'toolbar' },
			acceptsState: state => pins.entries.get().some(pin => pin.id === state),
		}, { restore: false }));
	}
}
