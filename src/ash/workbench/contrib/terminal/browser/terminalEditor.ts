import { h, addDisposableListener, type IDimension } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { ITerminalService, ITerminalEditorService, type ITerminalInstance } from '../../../services/terminal/browser/terminal.js';
import { TerminalEditorInput } from './terminalEditorInput.js';
import './media/terminal.css';

/** Hosts the original xterm; disposing a pane releases its DOM lease, not its PTY. */
export class TerminalEditor extends EditorPane {
	readonly id = TerminalEditorInput.ID;
	private element!: HTMLElement;
	private instance: ITerminalInstance | undefined;
	private visible = false;

	constructor(
		@ITerminalService private readonly terminals: ITerminalService,
		@ITerminalEditorService private readonly editorTerminals: ITerminalEditorService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
	) { super(TerminalEditorInput.ID, theme, storage); }

	override create(parent: HTMLElement): void {
		this.element = h(parent.ownerDocument, 'div');
		this.element.className = 'ash-terminal-editor';
		parent.append(this.element);
		super.create(this.element);
		this._register(addDisposableListener(this.element, 'focusin', () => {
			if (this.instance) this.terminals.setActiveInstance(this.instance);
		}));
	}

	override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		if (!(input instanceof TerminalEditorInput)) throw new TypeError('Invalid terminal editor input');
		this.clearInput();
		signal.throwIfAborted();
		const instance = this.editorTerminals.getInstanceFromResource(input.resource);
		if (!instance) {
			this.element.textContent = localize('terminal.editor.unavailable', 'This terminal is no longer available. Create a new terminal to start another shell.');
			this.element.setAttribute('role', 'status');
			return;
		}
		this.element.removeAttribute('role');
		this.instance = instance;
		instance.target = TerminalLocation.Editor;
		instance.attachToElement(this.element);
		const screen = await instance.xtermReadyPromise;
		signal.throwIfAborted();
		if (this.instance === instance) screen?.setVisible(this.visible);
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.visible = visible;
		if (this.instance?.xterm?.element.parentElement === this.element) this.instance.xterm.setVisible(visible);
	}

	override clearInput(): void {
		// A move opens the destination before disposing the source pane.
		if (this.instance?.xterm?.element.parentElement === this.element) this.instance.detachFromElement();
		this.instance = undefined;
		this.element?.replaceChildren();
	}

	override layout(dimension: IDimension): void {
		this.element.style.width = `${dimension.width}px`;
		this.element.style.height = `${dimension.height}px`;
		if (this.instance?.xterm?.element.parentElement === this.element) this.instance.xterm.fit();
	}
	override focus(): void { this.instance?.xterm?.focus(); }
	override getControl(): ITerminalInstance | undefined { return this.instance; }
	protected override disposeCore(): void { this.clearInput(); super.disposeCore(); }
}
