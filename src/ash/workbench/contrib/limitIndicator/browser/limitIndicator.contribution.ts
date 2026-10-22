import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { ColorDetector } from '../../../../editor/contrib/colorPicker/browser/colorDetector.js';
import { FoldingController } from '../../../../editor/contrib/folding/browser/folding.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import {
	IStatusbarService, StatusbarAlignment, type IStatusbarEntryAccessor,
} from '../../../services/statusbar/browser/statusbar.js';

/** Projects the active editor's existing limit reports into its window's status bar. */
export class LimitIndicatorContribution extends Disposable {
	private readonly listeners = this._register(new DisposableStore());
	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@ICodeEditorService private readonly codeEditors: ICodeEditorService,
		@IEditorService editors: IEditorService,
		@IStatusbarService private readonly statusbar: IStatusbarService,
		@ICommandService private readonly commands: ICommandService,
	) {
		super();
		this._register(editors.onDidActiveEditorChange(() => this.followEditor()));
		this._register(codeEditors.onCodeEditorRemove(() => this.followEditor()));
		this.followEditor();
	}

	private followEditor(): void {
		this.listeners.clear();
		this.entry.clear();
		const editor = this.codeEditors.getActiveCodeEditor();
		if (!editor || editor.isSimpleWidget) {
			return;
		}
		this.listeners.add(editor.onDidChangeModel(() => this.followEditor()));
		const colors = ColorDetector.get(editor)?.limitReporter;
		const folding = FoldingController.get(editor)?.limitReporter;
		const update = (): void => {
			const messages: string[] = [];
			const settings: string[] = [];
			if (colors && colors.limited !== false) {
				messages.push(localize('limitIndicator.colors', 'Only {0} of {1} color decorations are shown for performance reasons.', colors.limited, colors.computed));
				settings.push('editor.colorDecoratorsLimit');
			}
			if (folding && folding.limited !== false) {
				messages.push(localize('limitIndicator.folding', 'Only {0} of {1} folding regions are available for performance reasons.', folding.limited, folding.computed));
				settings.push('editor.foldingMaximumRegions');
			}
			if (!messages.length) {
				this.entry.clear();
				return;
			}
			const text = localize('limitIndicator.title', 'Language features limited');
			const tooltip = [...messages, localize('limitIndicator.configure', 'Activate to configure the limits.')].join('\n');
			const value = {
				icon: Lxicon.warning, text, tooltip, ariaLabel: `${text}. ${tooltip}`,
				run: () => this.commands.executeCommand('workbench.action.openSettings', `@id:${settings[0]}`),
			};
			if (this.entry.value) {
				this.entry.value.update(value);
			} else {
				this.entry.value = this.statusbar.addEntry(value, { id: 'status.languageFeatureLimits', alignment: StatusbarAlignment.Right, priority: 15 });
			}
		};
		if (colors) this.listeners.add(colors.onDidChange(update));
		if (folding) this.listeners.add(folding.onDidChange(update));
		update();
	}
}

registerWorkbenchContribution('workbench.contrib.limitIndicator', WorkbenchPhase.AfterRestored, accessor => accessor.get(IInstantiationService).createInstance(LimitIndicatorContribution));
