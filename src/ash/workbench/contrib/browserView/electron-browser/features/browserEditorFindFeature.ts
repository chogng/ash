import { Disposable, MutableDisposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { localize } from '../../../../../nls.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import type { IBrowserViewModel } from '../../common/browserView.js';

interface FindSession { term: string; users: number; disposed: boolean; }
const sessions = new WeakMap<IBrowserViewModel, FindSession>();

/** Chromium owns matches; split editors share the page's last term and borrow one accessible input. */
export class BrowserEditorFindFeature extends Disposable {
	private model: IBrowserViewModel | undefined;
	private revision = 0;
	private readonly query = this._register(new MutableDisposable<IDisposable>());
	private readonly modelLifetime = this._register(new MutableDisposable<IDisposable>());

	constructor(@IQuickInputService private readonly quickInput: IQuickInputService) { super(); }

	public setModel(model: IBrowserViewModel | undefined): void {
		if (this.model === model) { return; }
		this.modelLifetime.clear();
		this.query.clear();
		if (this.model) {
			const previous = sessions.get(this.model);
			if (previous && --previous.users === 0) { void this.model.stopFindInPage().catch(() => { }); }
		}
		this.model = model;
		this.revision++;
		if (!model) { return; }
		let session = sessions.get(model);
		if (!session) {
			session = { term: '', users: 0, disposed: false };
			sessions.set(model, session);
			const captured = session;
			const lifetime = model.onWillDispose(() => { captured.disposed = true; sessions.delete(model); lifetime.dispose(); });
		}
		session.users++;
		this.modelLifetime.value = model.onWillDispose(() => this.setModel(undefined));
	}

	public async show(): Promise<void> {
		const model = this.model;
		const session = model && sessions.get(model);
		if (!model || !session) { return; }
		this.query.clear();
		const revision = ++this.revision;
		const selection = await model.getSelectedText();
		if (this.isDisposed || session.disposed || revision !== this.revision) { return; }
		const cancellation = new CancellationTokenSource();
		const lifetime = toDisposable(() => cancellation.dispose(true));
		this.query.value = lifetime;
		try {
			const value = await this.quickInput.input({
				title: localize({ bundle: 'ash.workbench', key: 'browser.find' }, 'Find in Page'),
				placeHolder: localize({ bundle: 'ash.workbench', key: 'browser.findPrompt' }, 'Enter text to find. Use F3 or Shift+F3 to move between matches.'),
				value: selection.trim() || session.term,
			}, cancellation.token);
			if (value && !this.isDisposed && !session.disposed && revision === this.revision) {
				session.term = value;
				await model.findInPage(value, { recompute: true });
				await model.focus();
			}
		} finally { if (this.query.value === lifetime) { this.query.clear(); } }
	}

	public async hide(): Promise<void> {
		this.revision++;
		this.query.clear();
		if (this.model) { await this.model.stopFindInPage(); await this.model.focus(); }
	}
	public async next(forward: boolean): Promise<void> {
		const session = this.model && sessions.get(this.model);
		if (this.model && session?.term) { await this.model.findInPage(session.term, { forward }); }
		else { await this.show(); }
	}

	protected override disposeCore(): void { this.setModel(undefined); super.disposeCore(); }
}

import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { BrowserViewCommandId } from '../../../../../platform/browserView/common/browserView.js';
import { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { BrowserViewEditorId } from '../../common/browserView.js';
import { ActiveEditorContext } from '../../../../common/contextkeys.js';
import { localize2 } from '../../../../../nls.js';
import type { BrowserEditor } from '../browserEditor.js';
registerAction2(class BrowserFeatureAction extends Action2 {
	constructor() { super({ id: BrowserViewCommandId.ShowFind, title: localize2({ bundle: 'ash.workbench', key: 'browser.findCommand' }, 'Browser: Find in Page'), f1: true, precondition: ActiveEditorContext.isEqualTo(BrowserViewEditorId) }); }
	override async run(accessor: import('../../../../../platform/instantiation/common/instantiation.js').ServicesAccessor): Promise<void> {
		const pane = accessor.get(IEditorPart).activePane;
		if (pane?.id === BrowserViewEditorId) { await (pane as BrowserEditor).showFind(); }
	}
});
registerAction2(class BrowserFeatureAction extends Action2 {
	constructor() { super({ id: BrowserViewCommandId.HideFind, title: localize2({ bundle: 'ash.workbench', key: 'browser.hideFindCommand' }, 'Browser: Stop Finding'), f1: true, precondition: ActiveEditorContext.isEqualTo(BrowserViewEditorId) }); }
	override async run(accessor: import('../../../../../platform/instantiation/common/instantiation.js').ServicesAccessor): Promise<void> {
		const pane = accessor.get(IEditorPart).activePane;
		if (pane?.id === BrowserViewEditorId) { await (pane as BrowserEditor).hideFind(); }
	}
});
registerAction2(class BrowserFeatureAction extends Action2 {
	constructor() { super({ id: BrowserViewCommandId.FindNext, title: localize2({ bundle: 'ash.workbench', key: 'browser.nextFindCommand' }, 'Browser: Find Next'), f1: true, precondition: ActiveEditorContext.isEqualTo(BrowserViewEditorId) }); }
	override async run(accessor: import('../../../../../platform/instantiation/common/instantiation.js').ServicesAccessor): Promise<void> {
		const pane = accessor.get(IEditorPart).activePane;
		if (pane?.id === BrowserViewEditorId) { await (pane as BrowserEditor).findNext(true); }
	}
});
registerAction2(class BrowserFeatureAction extends Action2 {
	constructor() { super({ id: BrowserViewCommandId.FindPrevious, title: localize2({ bundle: 'ash.workbench', key: 'browser.previousFindCommand' }, 'Browser: Find Previous'), f1: true, precondition: ActiveEditorContext.isEqualTo(BrowserViewEditorId) }); }
	override async run(accessor: import('../../../../../platform/instantiation/common/instantiation.js').ServicesAccessor): Promise<void> {
		const pane = accessor.get(IEditorPart).activePane;
		if (pane?.id === BrowserViewEditorId) { await (pane as BrowserEditor).findNext(false); }
	}
});
