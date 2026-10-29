import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import Severity from '../../../../base/common/severity.js';
import { getCodeEditor, type ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { EditorOption, filterValidationDecorations } from '../../../../editor/common/config/editorOptions.js';
import { IMarkerDecorationsService } from '../../../../editor/common/services/markerDecorations.js';
import { ColorDetector } from '../../../../editor/contrib/colorPicker/browser/colorDetector.js';
import { FoldingController } from '../../../../editor/contrib/folding/browser/folding.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ILanguageStatusService, type ILanguageStatus } from '../../../services/languageStatus/common/languageStatusService.js';

export interface LimitInfo {
	readonly onDidChange: Event<void>;
	readonly limited: number | string | false;
}

/** Publishes limits from the active pane; each feature keeps its own action and lifetime. */
export class LimitIndicatorContribution extends Disposable {
	private readonly listeners = this._register(new DisposableStore());
	private readonly statuses = new Map<string, { detail: string; registration: IDisposable }>();
	private editor: ICodeEditor | null = null;

	constructor(
		@IEditorService private readonly editors: IEditorService,
		@ILanguageStatusService private readonly languageStatus: ILanguageStatusService,
	) {
		super();
		this._register(editors.onDidActiveEditorChange(() => this.followEditor()));
		this.followEditor();
	}

	private followEditor(force = false): void {
		const editor = getCodeEditor(this.editors.activeEditorPane?.getControl());
		if (!force && editor === this.editor) return;
		this.editor = editor;
		this.listeners.clear();
		this.clearStatuses();
		if (!editor || editor.isSimpleWidget) {
			return;
		}
		this.listeners.add(editor.onDidChangeModel(() => this.followEditor(true)));
		this.listeners.add(
			editor.onDidDispose(() => {
				this.listeners.clear();
				this.clearStatuses();
			}),
		);
		if (!editor.getModel()) return;
		this.watch(
			'decoratorsLimitInfo',
			ColorDetector.get(editor)?.limitReporter,
			localize('limitIndicator.colorsLabel', 'Color decorators'),
			localize('limitIndicator.colorsName', 'Color Decorator Status'),
			localize('limitIndicator.colorsSource', 'Color Decorators'),
			'editor.colorDecoratorsLimit',
		);
		this.watch(
			'foldingLimitInfo',
			FoldingController.get(editor)?.limitReporter,
			localize('limitIndicator.foldingLabel', 'Folding ranges'),
			localize('limitIndicator.foldingName', 'Folding Status'),
			localize('limitIndicator.foldingSource', 'Folding'),
			'editor.foldingMaximumRegions',
		);
		this.watch(
			'diagnosticsLimitInfo',
			DiagnosticDecorationLimitReporter.get(editor) ?? undefined,
			localize('limitIndicator.problemsLabel', 'Problems'),
			localize('limitIndicator.problemsName', 'Problems Status'),
			localize('limitIndicator.problemsLabel', 'Problems'),
		);
	}

	private watch(id: string, reporter: LimitInfo | undefined, label: string, name: string, source: string, setting?: string): void {
		if (!reporter) return;
		const update = () => {
			const detail =
				typeof reporter.limited === 'string'
					? reporter.limited
					: reporter.limited === false
						? undefined
						: localize('limitIndicator.limited', 'only {0} shown for performance reasons', reporter.limited);
			const previous = this.statuses.get(id);
			if (detail === previous?.detail) return;
			previous?.registration.dispose();
			this.statuses.delete(id);
			if (!detail) return;
			const status: ILanguageStatus = {
				id,
				name,
				selector: '*',
				severity: Severity.Warning,
				label,
				detail,
				source,
				busy: false,
				command: setting
					? {
							id: 'workbench.action.openSettings',
							arguments: [setting],
							title: localize('limitIndicator.configureAction', 'Configure'),
						}
					: undefined,
				accessibilityInfo: undefined,
			};
			this.statuses.set(id, { detail, registration: this.languageStatus.addStatus(status) });
		};
		this.listeners.add(reporter.onDidChange(update));
		update();
	}

	private clearStatuses(): void {
		for (const status of this.statuses.values()) status.registration.dispose();
		this.statuses.clear();
	}

	protected override disposeCore(): void {
		this.clearStatuses();
		super.disposeCore();
	}
}

/** Reads diagnostic overflow from the decoration owner without retaining marker copies. */
export class DiagnosticDecorationLimitReporter extends Disposable implements LimitInfo {
	static readonly ID = 'editor.contrib.diagnosticDecorationLimitReporter';
	static get(editor: ICodeEditor): DiagnosticDecorationLimitReporter | null {
		return editor.getContribution<DiagnosticDecorationLimitReporter>(this.ID);
	}

	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private message: string | false = false;
	get limited(): string | false {
		return this.message;
	}

	constructor(editor: ICodeEditor, @IMarkerDecorationsService decorations: IMarkerDecorationsService) {
		super();
		const update = () => {
			const model = editor.getModel();
			const limit = model && !filterValidationDecorations(editor.getOptions()) ? decorations.getMarkerLimits(model.uri) : undefined;
			let message: string | false = false;
			if (limit?.isMarkersSourceTruncated && limit.isMarkersTruncated !== undefined) {
				message = localize(
					'limitIndicator.diagnosticsBoth',
					'Some problems are not shown in the problems view, and only {0} problems are rendered in the editor for performance reasons.',
					limit.isMarkersTruncated,
				);
			} else if (limit?.isMarkersSourceTruncated) {
				message = localize('limitIndicator.diagnosticsSource', 'Some problems are not shown in the problems view for performance reasons.');
			} else if (limit?.isMarkersTruncated !== undefined) {
				message = localize('limitIndicator.diagnosticsEditor', 'Only {0} problems are rendered in the editor for performance reasons.', limit.isMarkersTruncated);
			}
			if (message === this.message) return;
			this.message = message;
			this.changed.fire();
		};
		this._register(editor.onDidChangeModel(update));
		this._register(
			editor.onDidChangeConfiguration(event => {
				if (event.hasChanged(EditorOption.renderValidationDecorations) || event.hasChanged(EditorOption.readOnly)) update();
			}),
		);
		this._register(
			decorations.onDidChangeMarkerLimit(model => {
				if (model === editor.getModel()) update();
			}),
		);
		update();
	}
}

registerEditorContribution(DiagnosticDecorationLimitReporter.ID, DiagnosticDecorationLimitReporter, EditorContributionInstantiation.Lazy);
registerWorkbenchContribution('workbench.contrib.limitIndicator', WorkbenchPhase.AfterRestored, accessor => accessor.get(IInstantiationService).createInstance(LimitIndicatorContribution));
