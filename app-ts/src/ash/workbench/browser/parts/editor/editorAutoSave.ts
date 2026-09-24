import { addDisposableListener } from "../../../../base/browser/dom.js";
import { DisposableMap, Disposable, DisposableStore, toDisposable } from "../../../../base/common/lifecycle.js";
import type { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { EditorAutoSaveConfiguration, EditorAutoSaveDelayConfiguration, type EditorAutoSaveMode } from "../../../services/editor/common/editorConfiguration.js";
import type { IWorkingCopy, IWorkingCopyService } from "../../../services/workingCopy/common/workingCopyService.js";
import type { IEditorPart } from "./editorPart.js";

/** Coordinates configuration-driven saves without taking ownership of editor models. */
export class EditorAutoSaveContribution extends Disposable {
	private readonly registrations = this._register(new DisposableMap<IWorkingCopy, DisposableStore>());
	private readonly windowListeners = this._register(new DisposableMap<Window, DisposableStore>());
	private readonly timers = new Map<IWorkingCopy, { readonly ownerWindow: Window; readonly handle: number }>();
	private readonly saving = new Set<IWorkingCopy>();
	private activeWorkingCopy: IWorkingCopy | undefined;

	constructor(
		private readonly editorPart: IEditorPart,
		private readonly workingCopies: IWorkingCopyService,
		private readonly configuration: IConfigurationService,
	) {
		super();
		for (const workingCopy of workingCopies.getAll()) this.attach(workingCopy);
		this._register(workingCopies.onDidRegister(workingCopy => this.attach(workingCopy)));
		this._register(workingCopies.onDidUnregister(workingCopy => this.detach(workingCopy)));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (!event.affectsConfiguration(EditorAutoSaveConfiguration) && !event.affectsConfiguration(EditorAutoSaveDelayConfiguration)) return;
			this.clearTimers();
			if (this.mode === "afterDelay") {
				for (const workingCopy of workingCopies.getAll()) this.schedule(workingCopy);
			}
		}));
		this.activeWorkingCopy = editorPart.activePane?.workingCopy;
		this._register(editorPart.onDidChangeEditors(() => {
			this.attachWindow(editorPart.domNode.ownerDocument.defaultView);
			this.handleActiveEditorChange();
		}));
		this.attachWindow(editorPart.domNode.ownerDocument.defaultView);
		this._register(toDisposable(() => this.clearTimers()));
	}

	private get mode(): EditorAutoSaveMode {
		return this.configuration.getValue(EditorAutoSaveConfiguration);
	}

	private attach(workingCopy: IWorkingCopy): void {
		if (this.registrations.has(workingCopy)) return;
		const resources = new DisposableStore();
		resources.add(workingCopy.onDidChangeContent(() => this.schedule(workingCopy)));
		resources.add(workingCopy.onDidChangeDirty(() => {
			if (workingCopy.isDirty) this.schedule(workingCopy);
			else this.clearTimer(workingCopy);
		}));
		resources.add(toDisposable(() => this.clearTimer(workingCopy)));
		this.registrations.set(workingCopy, resources);
		this.schedule(workingCopy);
	}

	private attachWindow(ownerWindow: Window | null): void {
		if (!ownerWindow || this.windowListeners.has(ownerWindow)) return;
		const listeners = new DisposableStore();
		listeners.add(addDisposableListener(ownerWindow, "blur", () => {
			if (this.mode !== "onWindowChange") return;
			for (const workingCopy of this.workingCopies.getAll()) void this.save(workingCopy);
		}));
		listeners.add(addDisposableListener(ownerWindow, "unload", () => this.windowListeners.deleteAndDispose(ownerWindow)));
		this.windowListeners.set(ownerWindow, listeners);
	}

	private detach(workingCopy: IWorkingCopy): void {
		this.registrations.deleteAndDispose(workingCopy);
		this.saving.delete(workingCopy);
		if (this.activeWorkingCopy === workingCopy) this.activeWorkingCopy = undefined;
	}

	private schedule(workingCopy: IWorkingCopy): void {
		this.clearTimer(workingCopy);
		if (this.isDisposed || this.mode !== "afterDelay" || !workingCopy.isDirty || workingCopy.hasExternalChange) return;
		const ownerWindow = this.editorPart.domNode.ownerDocument.defaultView;
		if (!ownerWindow) return;
		const handle = ownerWindow.setTimeout(() => {
			this.timers.delete(workingCopy);
			void this.save(workingCopy);
		}, this.configuration.getValue(EditorAutoSaveDelayConfiguration));
		this.timers.set(workingCopy, { ownerWindow, handle });
	}

	private handleActiveEditorChange(): void {
		const previous = this.activeWorkingCopy;
		this.activeWorkingCopy = this.editorPart.activePane?.workingCopy;
		if (this.mode === "onFocusChange" && previous && previous !== this.activeWorkingCopy) void this.save(previous);
	}

	private async save(workingCopy: IWorkingCopy): Promise<void> {
		if (!workingCopy.isDirty || workingCopy.hasExternalChange || this.saving.has(workingCopy)) return;
		this.saving.add(workingCopy);
		try {
			await workingCopy.save(new AbortController().signal);
		} catch (error) {
			console.error(`Auto save failed for '${workingCopy.resource.toString()}'`, error);
		} finally {
			this.saving.delete(workingCopy);
			if (!this.isDisposed && workingCopy.isDirty) this.schedule(workingCopy);
		}
	}

	private clearTimer(workingCopy: IWorkingCopy): void {
		const timer = this.timers.get(workingCopy);
		if (timer === undefined) return;
		timer.ownerWindow.clearTimeout(timer.handle);
		this.timers.delete(workingCopy);
	}

	private clearTimers(): void {
		for (const workingCopy of this.timers.keys()) this.clearTimer(workingCopy);
	}
}
