import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { SideBySideEditor } from '../../../browser/parts/editor/sideBySideEditor.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';
import { isEditorPaneWithScrolling, type IEditorPane, type IEditorPaneScrollPosition, type IEditorPaneWithScrolling } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IStatusbarService, StatusbarAlignment, type IStatusbarEntryAccessor } from '../../../services/statusbar/browser/statusbar.js';

const toggleCommand = 'workbench.action.toggleLockedScrolling';
const holdCommand = 'workbench.action.holdLockedScrolling';

/** Window-owned relative scrolling across the panes exposed by the editor service. */
export class SyncScroll extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.syncScrolling';
	private static readonly instances = new WeakMap<IEditorService, SyncScroll>();
	private readonly activeListeners = this._register(new DisposableStore());
	private readonly paneListeners = this._register(new DisposableStore());
	private readonly status = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly baseline = new Map<IEditorPaneWithScrolling, IEditorPaneScrollPosition>();
	private active = false;
	private applying = false;
	private revision = 0;

	// Commands belong to the realm; resolve their controller from the invoking window.
	static {
		registerAction2(
			class extends Action2 {
				constructor() {
					super({
						id: toggleCommand,
						title: localize('scrollLocking.toggle', 'Toggle Locked Scrolling Across Editors'),
						f1: true,
					});
				}
				run(accessor: ServicesAccessor): void {
					SyncScroll.instances.get(accessor.get(IEditorService))?.toggle();
				}
			},
		);
		registerAction2(
			class extends Action2 {
				constructor() {
					super({
						id: holdCommand,
						title: localize('scrollLocking.hold', 'Hold Locked Scrolling Across Editors'),
					});
				}
				run(accessor: ServicesAccessor): void {
					SyncScroll.instances.get(accessor.get(IEditorService))?.hold(accessor.get(IKeybindingService));
				}
			},
		);
	}

	constructor(
		@IEditorService private readonly editors: IEditorService,
		@IStatusbarService private readonly statusbar: IStatusbarService,
		@IAccessibilityService private readonly accessibility: IAccessibilityService,
	) {
		super();
		SyncScroll.instances.set(editors, this);
		this._register(
			toDisposable(() => {
				SyncScroll.instances.delete(editors);
				this.baseline.clear();
			}),
		);
	}

	toggle(): void {
		if (this.isDisposed) return;
		this.revision++;
		this.setActive(!this.active);
	}

	private hold(keybindings: IKeybindingService): void {
		const release = keybindings.enableKeybindingHoldMode(holdCommand);
		const previous = this.active;
		this.toggle();
		if (!release) return;
		const revision = this.revision;
		void release.then(() => {
			// A later explicit toggle owns the state even if the earlier key is still held.
			if (!this.isDisposed && revision === this.revision) this.setActive(previous);
		});
	}

	private setActive(active: boolean): void {
		this.active = active;
		this.activeListeners.clear();
		this.paneListeners.clear();
		this.baseline.clear();
		if (active) {
			this.activeListeners.add(this.editors.onDidVisibleEditorsChange(() => this.bindPanes()));
			this.bindPanes();
			const text = localize('scrollLocking.enabled', 'Scrolling Locked');
			this.status.value = this.statusbar.addEntry(
				{
					text,
					ariaLabel: text,
					tooltip: localize('scrollLocking.tooltip', 'Disable locked scrolling across editors'),
					run: () => this.toggle(),
				},
				{ id: 'status.scrollLockingEnabled', alignment: StatusbarAlignment.Right, priority: 102 },
			);
		} else {
			this.status.clear();
		}
		this.accessibility.status(active ? localize('scrollLocking.enabled', 'Scrolling Locked') : localize('scrollLocking.disabled', 'Locked scrolling disabled'));
	}

	private bindPanes(): void {
		this.paneListeners.clear();
		this.baseline.clear();
		const collect = (pane: IEditorPane): void => {
			if (pane instanceof SideBySideEditor) {
				collect(pane.getPrimaryEditorPane());
				collect(pane.getSecondaryEditorPane());
			} else if (isEditorPaneWithScrolling(pane) && !this.baseline.has(pane)) {
				this.baseline.set(pane, pane.getScrollPosition());
				this.paneListeners.add(pane.onDidChangeScroll(() => this.scrollFrom(pane)));
			}
		};
		for (const pane of this.editors.visibleEditorPanes) collect(pane);
	}

	private scrollFrom(source: IEditorPaneWithScrolling): void {
		if (this.applying) return;
		const origin = this.baseline.get(source);
		if (!origin) return;
		const position = source.getScrollPosition();
		const vertical = position.scrollTop - origin.scrollTop;
		const horizontal = position.scrollLeft !== undefined && origin.scrollLeft !== undefined ? position.scrollLeft - origin.scrollLeft : undefined;
		this.applying = true;
		try {
			for (const [pane, initial] of this.baseline) {
				if (pane === source) continue;
				const next = {
					scrollTop: initial.scrollTop + vertical,
					...(initial.scrollLeft !== undefined && horizontal !== undefined ? { scrollLeft: initial.scrollLeft + horizontal } : {}),
				};
				const current = pane.getScrollPosition();
				if (current.scrollTop !== next.scrollTop || (next.scrollLeft !== undefined && current.scrollLeft !== next.scrollLeft)) pane.setScrollPosition(next);
			}
		} finally {
			this.applying = false;
		}
	}
}
