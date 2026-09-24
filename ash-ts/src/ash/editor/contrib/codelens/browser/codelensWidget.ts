import './codelensWidget.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { type IViewZone } from '../../../browser/editorBrowser.js';
import { type View } from '../../../browser/view.js';
import { Position } from '../../../common/core/position.js';
import { type CodeLens, type Command } from '../../../common/languages.js';
import { type CodeLensItem } from './codelens.js';

export type ExecuteCodeLensCommand = (command: Command) => void;

/** Owns the stable DOM and interactions for one line of code lenses. */
export class CodeLensWidget extends Disposable {
	public readonly domNode: HTMLDivElement;
	private items: readonly CodeLensItem[];
	private currentCommands: readonly Command[] = [];
	private commandsResolved = false;
	private readonly viewZone: IViewZone;
	private readonly viewZoneId: string;
	private computedHeight = 0;

	public constructor(private readonly viewport: View, items: readonly CodeLensItem[], private readonly executeCommand?: ExecuteCodeLensCommand) {
		super();
		this.items = items;
		this.domNode = h(viewport.domNode.domNode.ownerDocument, 'div');
		this.domNode.className = 'stanza-editor-widget stanza-editor-codelens';
		this.domNode.setAttribute('role', 'group');
		this.domNode.setAttribute('aria-label', localize('commands', 'CodeLens commands'));
		this.viewZone = {
			afterLineNumber: this.afterLineNumber,
			afterColumn: Number.MAX_SAFE_INTEGER,
			heightInPx: this.codeLensHeight,
			suppressMouseDown: true,
			domNode: this.domNode,
			onComputedHeight: height => { this.computedHeight = height; },
		};
		let viewZoneId = '';
		viewport.changeViewZones(accessor => { viewZoneId = accessor.addZone(this.viewZone); });
		this.viewZoneId = viewZoneId;
		this._register(toDisposable(() => viewport.changeViewZones(accessor => accessor.removeZone(this.viewZoneId))));
		this._register(addDisposableListener<MouseEvent>(this.domNode, 'click', event => {
			const button = (event.target as Element | null)?.closest<HTMLButtonElement>('.stanza-editor-codelens-command');
			if (!(button instanceof this.domNode.ownerDocument.defaultView!.HTMLButtonElement) || button.parentElement !== this.domNode || !this.executeCommand) return;
			const command = this.currentCommands[Number(button.dataset.commandIndex)];
			if (command) this.executeCommand(command);
		}));
		this.render(this.initialSymbols);
		this.layout();
	}

	public getItems(): readonly CodeLensItem[] {
		return this.items;
	}

	public get needsResolve(): boolean {
		return !this.commandsResolved && this.items.some(item => !item.symbol.command && item.provider.resolveCodeLens !== undefined);
	}

	public updateCodeLensItems(items: readonly CodeLensItem[]): void {
		this.items = items;
		this.commandsResolved = false;
		this.render(this.initialSymbols);
		this.layout();
	}

	public updateCommands(symbols: ReadonlyArray<CodeLens | undefined | null>): void {
		this.items = this.items.map((item, index) => symbols[index]
			? Object.freeze({ symbol: symbols[index]!, provider: item.provider })
			: item);
		this.commandsResolved = true;
		this.render(this.initialSymbols);
	}

	public layout(): void {
		this.viewZone.afterLineNumber = this.afterLineNumber;
		this.viewZone.heightInPx = this.codeLensHeight;
		this.viewport.changeViewZones(accessor => accessor.layoutZone(this.viewZoneId));
		const range = this.items[0]!.symbol.range;
		const coordinates = this.viewport.getPositionContentCoordinates(new Position(range.startLineNumber, range.startColumn));
		this.domNode.style.left = `${Math.max(4, coordinates.left)}px`;
	}

	public isVisible(): boolean {
		return this.computedHeight > 0 && this.domNode.dataset.visibleViewZone === 'true';
	}

	private get afterLineNumber(): number {
		const range = this.items[0]!.symbol.range;
		return range.startLineNumber - 1;
	}

	private get codeLensHeight(): number {
		return Math.max(11, Math.floor(this.viewport.viewportLayout.lineHeight * 0.7));
	}

	private get initialSymbols(): readonly (CodeLens | undefined)[] {
		return this.items.map(item => item.symbol.command ? item.symbol : undefined);
	}

	private render(symbols: readonly (CodeLens | undefined)[]): void {
		const commands = symbols.flatMap(symbol => symbol?.command ? [symbol.command] : []);
		this.currentCommands = commands;
		if (commands.length === 0) {
			this.domNode.replaceChildren();
			this.domNode.hidden = true;
			return;
		}
		const children: HTMLElement[] = [];
		for (let index = 0; index < commands.length; index += 1) {
			if (index > 0) {
				const separator = h(this.domNode.ownerDocument, 'span');
				separator.className = 'stanza-editor-codelens-separator';
				separator.textContent = '\u00a0|\u00a0';
				separator.setAttribute('aria-hidden', 'true');
				children.push(separator);
			}
			const command = commands[index]!;
			const element = h(this.domNode.ownerDocument, this.executeCommand && command.id.length > 0 ? 'button' : 'span');
			element.className = 'stanza-editor-codelens-command';
			element.textContent = command.title.trim();
			if (element instanceof this.domNode.ownerDocument.defaultView!.HTMLButtonElement) {
				element.type = 'button';
				element.dataset.commandIndex = String(index);
			}
			children.push(element);
		}
		this.domNode.replaceChildren(...children);
		this.domNode.hidden = false;
	}
}
