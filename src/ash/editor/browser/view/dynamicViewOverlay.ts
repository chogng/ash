import { ViewEventHandler } from '../../common/viewEventHandler.js';
import { type RenderingContext } from './renderingContext.js';

/** Base for overlays rendered from one editor view context. */
export abstract class DynamicViewOverlay extends ViewEventHandler {
	public abstract prepareRender(context: RenderingContext): void;

	public abstract render(startLineNumber: number, lineNumber: number): string;
}
