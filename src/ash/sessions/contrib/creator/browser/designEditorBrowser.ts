import type { DesignTextStyle } from '../common/model/designText.js';
import type { IAction } from '../../../../base/common/actions.js';
import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { DocumentCommands } from '../common/commands/documentCommands.js';
import type { DesignMode, DesignTool } from '../common/config/editorConfiguration.js';
import type { DesignPoint } from '../common/core/geometry.js';
import type { DesignDocument, DesignShape } from '../common/model/document.js';
import type { DesignSelection } from '../common/selection.js';
import type { DesignDocumentController } from './designDocumentController.js';

/** A sampled scene carries presentation geometry without changing the editable document. */
export interface DesignScene {
	readonly shapes: readonly DesignShape[];
	readonly opacity: ReadonlyMap<string, number>;
}

/** DOM events and pointer capture stay in browser input; drawing receives design coordinates. */
export interface DesignDrawingParticipant {
	readonly preview: DesignShape | undefined;
	begin(point: DesignPoint, modifiers?: { shift: boolean; alt: boolean; tolerance: number; }): boolean;
	update(point: DesignPoint, modifiers?: { shift: boolean; alt: boolean; }): void;
	end(): void;
	complete(): boolean;
	cancel(): void;
}

export interface IDesignDrawingContribution extends DesignDrawingParticipant {
	readonly onDidChange: Event<void>;
}

export interface IDesignMotionContribution {
	readonly domNode: HTMLElement;
	readonly onDidChangeTime: Event<void>;
	getScene(): DesignScene;
	setActive(isActive: boolean): void;
	update(shape: DesignShape | undefined, isBusy: boolean): void;
}

export interface IDesignPropertiesContribution {
	readonly preview: DesignShape | undefined;
	cancel(): void;
	focus(): void;
	readonly domNode: HTMLElement;
	update(shape: DesignShape | undefined, isVisible: boolean): void;
	getActions(): readonly IAction[];
}

export interface IDesignCodeContribution {
	readonly domNode: HTMLElement;
	update(document: DesignDocument, isActive: boolean, isBusy: boolean): void;
	getAccessibleContent(): string;
}

export interface IDesignPrototypeContribution {
	readonly domNode: HTMLElement;
	readonly previewDomNode: HTMLElement;
	update(scale: number, active: boolean): void;
	showPreview(): void;
	setVisible(visible: boolean): void;
	focusPreview(): boolean;
	getAccessibleContent(): string;
}

export interface IDesignTextContribution {
	readonly editingId: string | undefined;
	readonly typingStyleId: string | undefined;
	readonly typingStyle: DesignTextStyle | undefined;
	readonly range: { start: number; end: number; } | undefined;
	readonly onDidChangeSelection: Event<void>;
	edit(id: string): void;
	finish(commit?: boolean): void;
	update(): void;
	format(style: DesignTextStyle, styleId?: string): void;
	selectAll(): void;
	getAccessibleContent(): string;
	toggleFormat(format: 'bold' | 'italic' | 'underline'): void;
}

/** Each editor owns one contribution set; the set releases its feature instances together. */
export interface IDesignEditorContributions extends IDisposable {
	readonly drawing: IDesignDrawingContribution;
	readonly text: IDesignTextContribution;
	readonly prototype: IDesignPrototypeContribution;
	readonly motion: IDesignMotionContribution;
	readonly properties: IDesignPropertiesContribution;
	readonly code: IDesignCodeContribution;
}

export interface DesignEditorContributionContext {
	readonly ownerDocument: Document;
	readonly canvasDomNode: HTMLElement;
	readonly overlayDomNode: SVGGElement;
	toDesignPoint(point: { readonly clientX: number; readonly clientY: number; }): DesignPoint;
	readonly documentController: DesignDocumentController;
	readonly commands: DocumentCommands;
	readonly selection: DesignSelection;
	getTool(): DesignTool;
	getMode(): DesignMode;
	selectShape(id: string): void;
	renderCanvas(): void;
	focusCanvas(): void;
	runFileOperation(operation: () => Promise<void>): Promise<void>;
}

export type DesignEditorContributionFactory = (context: DesignEditorContributionContext) => IDesignEditorContributions;
