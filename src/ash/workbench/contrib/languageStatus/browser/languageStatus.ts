import { AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { Separator, type IAction } from '../../../../base/common/actions.js';
import { cancelOnDispose } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import Severity from '../../../../base/common/severity.js';
import { getCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import type { IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ILanguageStatusService, type ILanguageStatus } from '../../../services/languageStatus/common/languageStatusService.js';
import { IStatusbarService, StatusbarAlignment, type IStatusbarEntryAccessor } from '../../../services/statusbar/browser/statusbar.js';

/** Projects language status registrations using the shared status bar and menu owners. */
export class LanguageStatusContribution extends Disposable {
	static readonly Id = 'status.languageStatus';
	private readonly editorListeners = this._register(new DisposableStore());
	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly menu = this._register(new MutableDisposable<DisposableStore>());
	private readonly menuFocused: IContextKey<boolean>;

	constructor(
		@IEditorService private readonly editors: IEditorService,
		@ILanguageStatusService private readonly languageStatus: ILanguageStatusService,
		@IStatusbarService private readonly statusbar: IStatusbarService,
		@IContextMenuService private readonly menus: IContextMenuService,
		@IContextViewService private readonly contextView: IContextViewService,
		@ICommandService private readonly commands: ICommandService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super();
		this.menuFocused = contextKeys.createKey('languageStatusFocus', false);
		this._register(editors.onDidActiveEditorChange(() => this.followEditor()));
		this._register(languageStatus.onDidChange(() => this.update()));
		this.followEditor();
	}

	private followEditor(): void {
		this.menu.clear();
		this.editorListeners.clear();
		const editor = getCodeEditor(this.editors.activeEditorPane?.getControl());
		if (editor) {
			this.editorListeners.add(editor.onDidChangeModel(() => this.followEditor()));
			this.editorListeners.add(editor.onDidDispose(() => this.entry.clear()));
			const model = editor.getModel();
			if (model) {
				this.editorListeners.add(model.onDidChangeLanguage(() => this.update()));
				this.editorListeners.add(model.onWillDispose(() => this.entry.clear()));
			}
		}
		this.update();
	}

	private currentStatuses(): ILanguageStatus[] {
		const model = getCodeEditor(this.editors.activeEditorPane?.getControl())?.getModel();
		return model && !model.isDisposed() ? this.languageStatus.getLanguageStatus(model) : [];
	}

	private update(): void {
		const statuses = this.currentStatuses();
		if (!statuses.length) {
			this.menu.clear();
			this.entry.clear();
			return;
		}
		const text = localize('languageStatus.title', 'Language Status');
		const tooltip = statuses.map(status => `${typeof status.label === 'string' ? status.label : status.label.value}: ${status.detail}`).join('\n');
		const severity = Math.max(...statuses.map(status => status.severity));
		const entry = {
			text,
			tooltip,
			ariaLabel: `${text}. ${tooltip}`,
			icon: severity >= Severity.Error ? Lxicon.error : severity >= Severity.Warning ? Lxicon.warning : Lxicon.info,
			showProgress: statuses.some(status => status.busy),
			run: () => this.open(),
		};
		if (this.entry.value) this.entry.value.update(entry);
		else
			this.entry.value = this.statusbar.addEntry(entry, {
				id: LanguageStatusContribution.Id,
				alignment: StatusbarAlignment.Right,
				priority: 15,
			});
	}

	private open(): void {
		this.menu.clear();
		const anchor = this.contextView.container.ownerDocument.querySelector<HTMLElement>(`[data-statusbar-item-id="${LanguageStatusContribution.Id}"] .ash-statusbar-item-label`);
		if (!anchor) return;
		const resources = new DisposableStore();
		this.menu.value = resources;
		const actions: IAction[] = [];
		for (const status of this.currentStatuses()) {
			if (actions.length) actions.push(new Separator());
			const label = typeof status.label === 'string' ? status.label : status.label.value;
			actions.push({
				id: status.id,
				label: `${label}: ${status.detail}`,
				tooltip: status.name,
				enabled: false,
				run: () => undefined,
			});
			const command = status.command;
			if (command)
				actions.push({
					id: `${status.id}.configure`,
					label: localize('languageStatus.action', '{0}: {1}', label, command.title),
					tooltip: command.tooltip ?? '',
					enabled: true,
					run: () => this.commands.executeCommand(command.id, ...(command.arguments ?? [])),
				});
		}
		this.menuFocused.set(true);
		this.menus.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
			// Keep explanatory rows in the shared DOM surface, including accessible views.
			getMenuClassName: () => 'ash-language-status-menu',
			cancellationToken: cancelOnDispose(resources),
			anchorPosition: AnchorPosition.Above,
			autoSelectFirstItem: true,
			onHide: didCancel => {
				this.menuFocused.reset();
				if (didCancel && anchor.isConnected) anchor.focus();
			},
		});
	}

	protected override disposeCore(): void {
		this.menuFocused.reset();
		super.disposeCore();
	}
}
