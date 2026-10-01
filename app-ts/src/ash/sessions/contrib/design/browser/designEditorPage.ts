import { addDisposableListener, getWindow, type IDimension } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import type { ISessionsPageView } from '../../../browser/pages.js';
import { DesignDocumentController } from './designDocumentController.js';
import { DesignEditorWidget } from './widget/designEditorWidget.js';
import { createDesignEditorContributions } from '../design.main.js';

/** Sessions owns the page lifetime; the editor owns its DOM and editing state. */
export class DesignEditorPage extends Disposable implements ISessionsPageView {
	public readonly domNode: HTMLElement;
	private readonly editor: DesignEditorWidget;

	constructor(
		container: HTMLElement,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILifecycleService lifecycle: ILifecycleService,
	) {
		super();
		const document = this._register(instantiationService.createInstance(DesignDocumentController));
		this.editor = this._register(instantiationService.createInstance(DesignEditorWidget, container, document, createDesignEditorContributions));
		this.domNode = this.editor.domNode;
		this.editor.initialize();
		this._register(lifecycle.onBeforeShutdown(event => event.veto(document.isBusy || (document.isDirty && document.confirmDiscard()), 'designDocument')));
		// Browser unload cannot await a save dialog. Its synchronous prompt preserves the unsaved document.
		this._register(addDisposableListener(getWindow(this.domNode), 'beforeunload', (event: BeforeUnloadEvent) => {
			if (document.isDirty && !lifecycle.willShutdown) { event.preventDefault(); event.returnValue = ''; }
		}));
	}

	public focus(): void { this.editor.focus(); }
	public layout(dimension: IDimension): void { this.editor.layout(dimension); }
}
