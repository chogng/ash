import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput, IEditorPane } from '../../../common/editor.js';
import './media/disassemblyView.css';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { alert, status } from '../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { getHoverDelegate, type IManagedHover } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { getUriFromSource } from '../common/debugSource.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { Table } from '../../../../base/browser/ui/table/tableWidget.js';
import type { ITableColumn, ITableRenderer } from '../../../../base/browser/ui/table/table.js';
import { observeElementSize } from '../../../../base/browser/observer.js';
import type { IAction } from '../../../../base/common/actions.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { Range } from '../../../../editor/common/core/range.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IDebugService, type IDebugSession, type IDisassembledInstruction, type IInstructionBreakpoint } from '../../../services/debug/common/debugService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { CONTEXT_DISASSEMBLY_VIEW_FOCUS, DISASSEMBLY_VIEW_ID } from '../common/debug.js';

const PAGE_SIZE = 50;
interface InstructionCell { readonly instruction: IDisassembledInstruction; readonly column: 'address' | 'bytes' | 'instruction'; }
interface BreakpointCell { readonly button: Button; instruction: IDisassembledInstruction | undefined; }
interface TextCell { readonly text: HTMLElement; readonly hover: IManagedHover; }

/** Displays one paused session's DAP instruction window; DebugService owns breakpoints and frame focus. */
export class DisassemblyView extends EditorPane implements IEditorPane {
	public readonly id = DISASSEMBLY_VIEW_ID;
	public domNode!: HTMLElement;
	private table!: Table<IDisassembledInstruction>;
	private toolbar!: WorkbenchToolBar;
	private address!: InputBox;
	private go!: Button;
	private statusDomNode!: HTMLElement;
	private readonly inputResources = this._register(new DisposableStore());
	private readonly contentChanged = this._register(new Emitter<void>());
	public readonly onDidChangeContent = this.contentChanged.event;
	private inputSignal: AbortSignal | undefined;
	private generation = 0;
	private memoryReference: string | undefined;
	private instructionOffset = 0;
	private instructions: readonly IDisassembledInstruction[] = [];
	private loading = false;
	private updatingFrame = false;

	constructor(
		@IDebugService private readonly debug: IDebugService,
		@IEditorService private readonly editors: IEditorService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IKeybindingService private readonly keybindings: IKeybindingService,
		@IAccessibleViewService private readonly accessibleView: IAccessibleViewService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IUriIdentityService private readonly uriIdentity: IUriIdentityService,
		@ILogService private readonly logService: ILogService,
		@ITextModelService private readonly textModels: ITextModelService,
	) { super(DISASSEMBLY_VIEW_ID, themeService, storageService); }

	public override create(parent: HTMLElement): void {
		const document = parent.ownerDocument;
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-disassembly';
		parent.append(this.domNode);
		super.create(this.domNode);
		this._register(toDisposable(() => { this.generation++; this.domNode.remove(); }));
		const scope = this._register(this.contextKeys.createScoped(this.domNode));
		const focused = CONTEXT_DISASSEMBLY_VIEW_FOCUS.bindTo(scope);
		this._register(addDisposableListener(this.domNode, 'focusin', () => focused.set(true)));
		this._register(addDisposableListener(this.domNode, 'focusout', event => {
			if (!this.domNode.contains(event.relatedTarget as Node | null)) { focused.set(false); }
		}));
		const header = h(document, 'div');
		header.className = 'ash-disassembly-header';
		this.domNode.append(header);
		this.toolbar = this._register(new WorkbenchToolBar(header, this.contextMenus, { ariaLabel: localize('debug.disassemblyControls', 'Disassembly controls') }));
		const form = h(document, 'form');
		form.className = 'ash-disassembly-address';
		this.address = this._register(new InputBox(form, { ariaLabel: localize('debug.instructionAddress', 'Instruction address'), placeholder: localize('debug.instructionAddress', 'Instruction address'), presentation: 'compact' }));
		this._register(this.address.onDidChange(() => this.address.showValidation('')));
		this.go = this._register(new Button(form, { label: localize('debug.disassemblyGo', 'Go to address'), type: 'submit' }));
		header.append(form);
		this._register(addDisposableListener(form, 'submit', event => {
			event.preventDefault();
			if (!this.address.value.trim()) { this.address.showValidation(localize('debug.instructionAddressRequired', 'Enter an instruction address.')); return; }
			void this.load(this.address.value, 0);
		}));
		this.statusDomNode = h(document, 'div');
		this.statusDomNode.className = 'ash-disassembly-status';
		this.statusDomNode.setAttribute('role', 'status');
		this.domNode.append(this.statusDomNode);
		const container = h(document, 'div');
		container.className = 'ash-disassembly-instructions';
		this.domNode.append(container);
		const breakpointRenderer: ITableRenderer<IDisassembledInstruction, BreakpointCell> = {
			templateId: 'breakpoint',
			renderTemplate: cell => {
				const template: BreakpointCell = { instruction: undefined, button: new Button(cell, { icon: Lxicon.circleSmallFilled, iconOnly: true, size: 'small', label: localize('debug.toggleBreakpoint', 'Toggle Breakpoint'), onClick: () => { if (template.instruction) { this.toggleInstructionBreakpoint(template.instruction); } } }) };
				return template;
			},
			renderElement: (instruction, _index, template) => {
				template.instruction = instruction;
				const breakpoint = this.breakpointFor(instruction);
				template.button.enabled = this.canInspect() && !this.loading && this.debug.session!.capabilities.supportsInstructionBreakpoints && instruction.presentationHint !== 'invalid';
				template.button.label = localize('debug.instructionBreakpointAt', 'Toggle instruction breakpoint at {0}', instruction.address);
				template.button.domNode.setAttribute('aria-pressed', String(Boolean(breakpoint)));
				template.button.domNode.classList.toggle('checked', Boolean(breakpoint));
				template.button.domNode.classList.toggle('disabled-breakpoint', breakpoint?.enabled === false);
				template.button.domNode.classList.toggle('unverified', breakpoint !== undefined && !breakpoint.verified);
			},
			disposeTemplate: template => template.button.dispose(),
		};
		const textRenderer: ITableRenderer<InstructionCell, TextCell> = {
			templateId: 'instruction-text',
			renderTemplate: cell => {
				const text = h(document, 'span'); text.className = 'ash-disassembly-text'; cell.append(text);
				return { text, hover: getHoverDelegate().setupHover({ target: text, content: '' }) };
			},
			renderElement: (cell, _index, template) => {
				const text = template.text;
				const instruction = cell.instruction;
				let value = instruction.address;
				if (cell.column === 'bytes') { value = instruction.instructionBytes ?? ''; }
				if (cell.column === 'instruction') { value = instruction.symbol ? `${instruction.instruction} — ${instruction.symbol}` : instruction.instruction; }
				text.textContent = value;
				template.hover.update(value);
				const current = sameAddress(instruction.address, this.debug.focusedStackFrame?.instructionPointerReference);
				text.classList.toggle('current', current);
				if (cell.column === 'address') {
					text.dataset.instructionAddress = instruction.address;
					if (current) { text.setAttribute('aria-current', 'step'); } else { text.removeAttribute('aria-current'); }
				}
			},
			disposeTemplate: template => template.hover.dispose(),
		};
		const columns: ITableColumn<IDisassembledInstruction, unknown>[] = [{ label: localize('debug.breakpoints', 'Breakpoints'), templateId: 'breakpoint', weight: 1, minimumWidth: 36, maximumWidth: 36, project: instruction => instruction }];
		for (const [column, label, weight, minimumWidth] of [
			['address', localize('debug.disassemblyAddress', 'Address'), 2, 120],
			['bytes', localize('debug.disassemblyBytes', 'Machine code'), 2, 120],
			['instruction', localize('debug.disassemblyInstruction', 'Instruction'), 5, 180],
		] as const) {
			columns.push({ label, templateId: 'instruction-text', weight, minimumWidth, project: instruction => ({ instruction, column }) });
		}
		this.table = this._register(new Table('DisassemblyView', container, { headerRowHeight: 28, getHeight: () => 28 }, columns, [breakpointRenderer, textRenderer], {
			ariaLabel: localize('debug.disassembly', 'Disassembly'), scrolling: 'internal',
			accessibilityProvider: { getAriaLabel: instruction => this.instructionText(instruction) },
		}));
		this._register(observeElementSize(container, size => this.table.layout(size.height, size.width)));
		this._register(this.table.onDidChangeFocus(() => this.renderControls()));
		this._register(addDisposableListener(this.table.domNode, 'keydown', event => {
			if ((event.target as HTMLElement).closest('input,button')) { return; }
			if (event.key === 'F9') { event.preventDefault(); event.stopPropagation(); this.toggleBreakpoint(); }
			if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void this.openSource(); }
		}));
		const updateHint = (): void => {
			const hint = this.accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.Disassembly);
			if (hint) { this.table.domNode.setAttribute('aria-description', hint); } else { this.table.domNode.removeAttribute('aria-description'); }
		};
		updateHint();
		this._register(this.configuration.onDidChangeConfiguration(event => { if (event.affectsConfiguration(AccessibilityVerbositySettingId.Disassembly)) { updateHint(); } }));
		this._register(this.keybindings.onDidUpdateKeybindings(updateHint));
	}

	public override async setInput(_input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		this.clearInput();
		this.inputSignal = signal;
		const abort = (): void => { this.generation++; };
		signal.addEventListener('abort', abort, { once: true });
		this.inputResources.add(toDisposable(() => signal.removeEventListener('abort', abort)));
		this.inputResources.add(this.debug.onDidChangeSession(() => { void this.refreshSession(); }));
		this.inputResources.add(this.debug.onDidFocusStackFrame(frame => {
			if (!this.updatingFrame && frame?.instructionPointerReference && this.canInspect()) { void this.load(frame.instructionPointerReference, 0); }
		}));
		this.inputResources.add(this.debug.onDidChangeBreakpoints(() => this.table.rerender()));
		await this.refreshSession();
		signal.throwIfAborted();
	}

	public override clearInput(): void {
		this.generation++;
		this.inputResources.clear();
		this.inputSignal = undefined;
		this.memoryReference = undefined;
		this.instructionOffset = 0;
		this.instructions = [];
		this.loading = false;
		this.table.splice(0, this.table.length);
		this.address.value = '';
		this.statusDomNode.textContent = '';
		this.renderControls();
		this.contentChanged.fire();
	}
	public override layout(dimension: IDimension): void { this.domNode.style.width = `${dimension.width}px`; this.domNode.style.height = `${dimension.height}px`; }
	public override focus(): void { this.table.domFocus(); }
	public override getControl(): DisassemblyView { return this; }
	public getAccessibleContent(): string { return this.instructions.length ? this.instructions.map(instruction => this.instructionText(instruction)).join('\n') : this.statusDomNode.textContent!; }
	public toggleBreakpoint(): void { const instruction = this.selectedInstruction(); if (instruction) { this.toggleInstructionBreakpoint(instruction); } }
	public async step(operation: 'stepOver' | 'stepInto' | 'stepOut'): Promise<void> {
		if (!this.canInspect()) { return; }
		try { await this.debug.session![operation]('instruction'); } catch (error) { this.showError(error); }
	}

	private canInspect(): boolean { return Boolean(this.inputSignal && !this.inputSignal.aborted && this.debug.session?.state === 'stopped' && this.debug.session.capabilities.supportsDisassembleRequest); }
	private async refreshSession(): Promise<void> {
		const session = this.debug.session;
		if (!this.canInspect()) {
			this.generation++;
			this.instructions = [];
			this.table.splice(0, this.table.length);
			this.loading = false;
			this.memoryReference = undefined;
			this.address.value = '';
			this.statusDomNode.textContent = session && !session.capabilities.supportsDisassembleRequest ? localize('debug.disassemblyUnsupported', 'The debug adapter does not support disassembly.') : localize('debug.disassemblyRequiresPause', 'Pause debugging to view disassembly.');
			this.renderControls();
			this.contentChanged.fire();
			return;
		}
		const generation = ++this.generation;
		this.loading = true;
		this.memoryReference = undefined;
		this.renderControls();
		try {
			const frames = this.debug.focusedStackFrame ? [this.debug.focusedStackFrame] : await session!.stackTrace();
			if (!this.isCurrent(session!, generation)) { return; }
			const reference = frames[0]?.instructionPointerReference;
			if (!this.debug.focusedStackFrame && frames[0]) {
				// Publish the frame for other consumers without requesting this instruction window twice.
				this.updatingFrame = true;
				try { this.debug.focusStackFrame(frames[0]); } finally { this.updatingFrame = false; }
			}
			if (reference) { await this.load(reference, 0); }
			else {
				this.instructions = [];
				this.memoryReference = undefined;
				this.table.splice(0, this.table.length);
				this.statusDomNode.textContent = localize('debug.disassemblyNoAddress', 'This stack frame has no instruction address. Enter an address to inspect.');
			}
		} catch (error) {
			if (this.isCurrent(session!, generation)) { this.instructions = []; this.table.splice(0, this.table.length); this.showError(error); }
		} finally {
			if (this.isCurrent(session!, generation)) { this.loading = false; this.renderControls(); this.table.rerender(); this.contentChanged.fire(); }
		}
	}

	private async load(reference: string, instructionOffset: number): Promise<void> {
		if (!this.canInspect()) { return; }
		const session = this.debug.session!;
		const generation = ++this.generation;
		this.loading = true;
		this.statusDomNode.textContent = localize('debug.disassemblyLoading', 'Loading instructions…');
		this.renderControls();
		try {
			const instructions = await session.disassemble(reference, 0, instructionOffset, PAGE_SIZE);
			if (!this.isCurrent(session, generation)) { return; }
			this.memoryReference = reference;
			this.instructionOffset = instructionOffset;
			this.instructions = instructions;
			this.address.value = reference;
			this.table.splice(0, this.table.length, instructions);
			this.table.setFocus(instructions.length ? [0] : []);
			this.statusDomNode.textContent = instructions.length ? localize('debug.disassemblyCount', '{0} instructions', instructions.length) : localize('debug.disassemblyEmpty', 'No instructions at this address.');
			status(this.statusDomNode.textContent);
			this.contentChanged.fire();
		} catch (error) {
			if (this.isCurrent(session, generation)) { this.instructions = []; this.table.splice(0, this.table.length); this.showError(error); }
		} finally {
			if (this.isCurrent(session, generation)) { this.loading = false; this.renderControls(); this.table.rerender(); }
		}
	}
	private isCurrent(session: IDebugSession, generation: number): boolean { return !this.isDisposed && this.canInspect() && this.debug.session === session && generation === this.generation; }
	private selectedInstruction(): IDisassembledInstruction | undefined { const index = this.table.getFocus()[0]; return index === undefined ? undefined : this.instructions[index]; }
	private instructionText(instruction: IDisassembledInstruction): string {
		const current = sameAddress(instruction.address, this.debug.focusedStackFrame?.instructionPointerReference) ? localize('debug.disassemblyCurrent', 'Current instruction') + ': ' : '';
		return `${current}${instruction.address} ${instruction.instructionBytes ?? ''} ${instruction.instruction}${instruction.symbol ? ` — ${instruction.symbol}` : ''}`;
	}
	private breakpointFor(instruction: IDisassembledInstruction): IInstructionBreakpoint | undefined {
		return this.debug.instructionBreakpoints.find(point => point.sessionId === this.debug.session?.id && sameAddress(instruction.address, point.instructionReference, point.offset));
	}
	private toggleInstructionBreakpoint(instruction: IDisassembledInstruction): void {
		if (!this.canInspect() || this.loading || !this.debug.session!.capabilities.supportsInstructionBreakpoints || instruction.presentationHint === 'invalid') { return; }
		const breakpoint = this.breakpointFor(instruction);
		try {
			if (breakpoint) { this.debug.removeBreakpoint(breakpoint.id); }
			else { this.debug.addInstructionBreakpoint({ instructionReference: instruction.address, offset: 0 }); }
		} catch (error) { this.showError(error); }
	}
	private async openSource(): Promise<void> {
		const instruction = this.selectedInstruction();
		if (!instruction?.location || !instruction.line || instruction.line < 1) { return; }
		try {
			const session = this.debug.session!;
			const generation = this.generation;
			const location = instruction.location;
			const selection = new Range(instruction.line, instruction.column || 1, instruction.endLine || instruction.line, instruction.endColumn || instruction.column || 1);
			if (location.sourceReference && location.sourceReference > 0) {
				const resource = getUriFromSource(location, location.path, session.id, this.uriIdentity, this.logService);
				using reference = await this.textModels.createModelReference(resource);
				if (!this.isCurrent(session, generation)) return;
				await this.editors.openEditor({ resource, label: location.name, readOnly: true }, { selection, pinned: true });
			} else if (location.resource) { await this.editors.openEditor({ resource: location.resource, label: location.name }, { selection, pinned: true }); }
		} catch (error) { this.showError(error); }
	}
	private renderControls(): void {
		const enabled = this.canInspect() && !this.loading;
		const instruction = this.selectedInstruction();
		const action = (id: string, label: string, icon: typeof Lxicon.add, canRun: boolean, run: () => void | Promise<void>): IAction => ({ id, label, tooltip: label, icon, enabled: canRun, run });
		this.toolbar.setActions([
			action('debug.disassemblyPrevious', localize('debug.disassemblyPrevious', 'Previous instructions'), Lxicon.arrowUp, enabled && Boolean(this.memoryReference), () => this.load(this.memoryReference!, this.instructionOffset - PAGE_SIZE)),
			action('debug.disassemblyNext', localize('debug.disassemblyNext', 'Next instructions'), Lxicon.arrowDown, enabled && Boolean(this.memoryReference), () => this.load(this.memoryReference!, this.instructionOffset + PAGE_SIZE)),
			action('debug.disassemblyCurrent', localize('debug.disassemblyCurrent', 'Current instruction'), Lxicon.target, enabled, () => this.refreshSession()),
			action('debug.disassemblySource', localize('debug.disassemblySource', 'Open instruction source'), Lxicon.fileCode, enabled && Boolean((instruction?.location?.resource || instruction?.location?.sourceReference) && instruction.line), () => this.openSource()),
			action('debug.disassemblyStepOver', localize('debug.disassemblyStepOver', 'Step over instruction'), Lxicon.arrowRight, enabled && this.debug.session!.capabilities.supportsSteppingGranularity, () => this.step('stepOver')),
			action('debug.disassemblyStepInto', localize('debug.disassemblyStepInto', 'Step into instruction'), Lxicon.arrowDown, enabled && this.debug.session!.capabilities.supportsSteppingGranularity, () => this.step('stepInto')),
			action('debug.disassemblyStepOut', localize('debug.disassemblyStepOut', 'Step out of instruction'), Lxicon.arrowUp, enabled && this.debug.session!.capabilities.supportsSteppingGranularity, () => this.step('stepOut')),
		]);
		this.address.enabled = enabled;
		this.go.enabled = enabled;
		this.table.domNode.setAttribute('aria-busy', String(this.loading));
	}
	private showError(error: unknown): void { this.statusDomNode.textContent = error instanceof Error ? error.message : String(error); alert(this.statusDomNode.textContent); this.contentChanged.fire(); }
}

function sameAddress(left: string, right: string | undefined, offset = 0): boolean {
	if (right === undefined) { return false; }
	const numeric = /^(?:0x[0-9a-f]+|\d+)$/i;
	if (numeric.test(left) && numeric.test(right)) { return BigInt(left) === BigInt(right) + BigInt(offset); }
	return offset === 0 && left === right;
}
