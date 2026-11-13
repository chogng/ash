import type { ArtifactCanvasTextStyle } from '../common/model/artifactCanvasText.js';
import type { IAction } from '../../../../base/common/actions.js';
import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { DocumentCommands } from '../common/commands/documentCommands.js';
import type { ArtifactCanvasMode, ArtifactCanvasTool } from '../common/config/artifactCanvasEditorConfiguration.js';
import type { CanvasPoint } from '../../canvas/common/canvasGeometry.js';
import type { ArtifactCanvasDocument, ArtifactCanvasShape } from '../common/model/artifactCanvasDocument.js';
import type { ArtifactCanvasSelection } from '../common/artifactCanvasSelection.js';
import type { CanvasViewport } from '../../canvas/common/canvasViewport.js';
import type { ArtifactCanvasImageSource } from './rendering/artifactCanvasMedia.js';
import type { ArtifactCanvasDocumentController } from './artifactCanvasDocumentController.js';

/** A sampled scene carries presentation geometry without changing the editable document. */
export interface ArtifactCanvasScene {
	readonly shapes: readonly ArtifactCanvasShape[];
	readonly opacity: ReadonlyMap<string, number>;
}

/** DOM events and pointer capture stay in browser input; drawing receives design coordinates. */
export interface ArtifactCanvasDrawingParticipant {
	readonly preview: ArtifactCanvasShape | undefined;
	begin(point: CanvasPoint, modifiers?: { shift: boolean; alt: boolean; tolerance: number; }): boolean;
	update(point: CanvasPoint, modifiers?: { shift: boolean; alt: boolean; }): void;
	end(): void;
	complete(): boolean;
	cancel(): void;
}

export interface IArtifactCanvasDrawingContribution extends ArtifactCanvasDrawingParticipant {
	readonly onDidChange: Event<void>;
}

export interface IArtifactCanvasMotionContribution {
	readonly domNode: HTMLElement;
	readonly onDidChangeTime: Event<void>;
	getScene(): ArtifactCanvasScene;
	setActive(isActive: boolean): void;
	update(shape: ArtifactCanvasShape | undefined, isBusy: boolean): void;
}

export interface IArtifactCanvasPropertiesContribution {
	readonly background: string;
	readonly preview: ArtifactCanvasShape | undefined;
	cancel(): void;
	focus(): void;
	readonly domNode: HTMLElement;
	update(shape: ArtifactCanvasShape | undefined, isVisible: boolean): void;
	getActions(): readonly IAction[];
}

export interface IArtifactCanvasCodeContribution {
	readonly domNode: HTMLElement;
	getSource(): string;
	update(document: ArtifactCanvasDocument, isActive: boolean, isBusy: boolean): void;
	getAccessibleContent(): string;
}

export interface IArtifactCanvasPrototypeContribution {
	readonly domNode: HTMLElement;
	readonly previewDomNode: HTMLElement;
	update(scale: number, active: boolean): void;
	showPreview(): void;
	setVisible(visible: boolean): void;
	focusPreview(): boolean;
	getAccessibleContent(): string;
}

export interface IArtifactCanvasTextContribution {
	readonly editingId: string | undefined;
	readonly typingStyleId: string | undefined;
	readonly typingStyle: ArtifactCanvasTextStyle | undefined;
	readonly range: { start: number; end: number; } | undefined;
	readonly onDidChangeSelection: Event<void>;
	edit(id: string): void;
	finish(commit?: boolean): void;
	update(): void;
	format(style: ArtifactCanvasTextStyle, styleId?: string): void;
	selectAll(): void;
	getAccessibleContent(): string;
	toggleFormat(format: 'bold' | 'italic' | 'underline'): void;
}

/** Each editor owns one contribution set; the set releases its feature instances together. */
export interface IArtifactCanvasEditorContributions extends IDisposable {
	readonly drawing: IArtifactCanvasDrawingContribution;
	readonly text: IArtifactCanvasTextContribution;
	readonly prototype: IArtifactCanvasPrototypeContribution;
	readonly motion: IArtifactCanvasMotionContribution;
	readonly properties: IArtifactCanvasPropertiesContribution;
	readonly code: IArtifactCanvasCodeContribution;
}

export interface ArtifactCanvasEditorContributionContext {
	readonly ownerDocument: Document;
	readonly canvasDomNode: HTMLElement;
	readonly overlayDomNode: SVGGElement;
	toDesignPoint(point: { readonly clientX: number; readonly clientY: number; }): CanvasPoint;
	readonly documentController: ArtifactCanvasDocumentController;
	readonly commands: DocumentCommands;
	readonly selection: ArtifactCanvasSelection;
	getTool(): ArtifactCanvasTool;
	getMode(): ArtifactCanvasMode;
	selectShape(id: string): void;
	renderCanvas(): void;
	focusCanvas(): void;
	runFileOperation(operation: () => Promise<void>): Promise<void>;
}

export interface ArtifactCanvasRenderState {
	readonly shapes: readonly ArtifactCanvasShape[];
	readonly images: ReadonlyMap<string, ArtifactCanvasImageSource>;
	readonly selectedShapes: readonly ArtifactCanvasShape[];
	readonly draft: ArtifactCanvasShape | undefined;
	readonly showPathHandles: boolean;
	readonly showWidthHandles?: boolean;
	readonly gradient?: { paintId?: string; stopId?: string; };
	readonly blur?: { effectId?: string; handle: 'start' | 'end'; };
	readonly selectedWidthPoints?: ReadonlySet<string>;
	readonly selectionRect?: { x: number; y: number; width: number; height: number; };
	readonly activeContour?: number;
	readonly selectedNodes?: ReadonlySet<number>;
	readonly scale: number;
	readonly opacity: ReadonlyMap<string, number> | undefined;
}

export interface IArtifactCanvasView extends IDisposable {
	readonly domNode: HTMLElement;
	readonly overlayDomNode: SVGGElement;
	setFocused(isFocused: boolean): void;
	setTool(tool: ArtifactCanvasTool): void;
	applyTransform(viewport: CanvasViewport): void;
	render(state: ArtifactCanvasRenderState): void;
}

export interface ArtifactCanvasEditorContributionFactory {
	createCanvasView(ownerDocument: Document): IArtifactCanvasView;
	createFeatures(context: ArtifactCanvasEditorContributionContext): IArtifactCanvasEditorContributions;
}
