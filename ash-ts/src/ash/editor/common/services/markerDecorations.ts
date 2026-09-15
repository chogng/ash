import { type LanguageDiagnosticsSource } from './languageDiagnosticsService.js';
import { type Event } from '../../../base/common/event.js';
import { type IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { type Marker } from '../../../platform/markers/common/markers.js';
import { Range } from '../core/range.js';
import { type IModelDecoration, type ITextModel } from '../model.js';

export const IMarkerDecorationsService = createDecorator<IMarkerDecorationsService>('markerDecorationsService');

export interface IMarkerDecorationsService {
	readonly _serviceBrand: undefined;
	/** Holds the model while at least one editor displays its markers. */
	acquire(model: ITextModel, diagnostics?: LanguageDiagnosticsSource): IDisposable;
	readonly onDidChangeMarker: Event<ITextModel>;
	getMarker(uri: URI, decoration: IModelDecoration): Marker | null;
	getLiveMarkers(uri: URI): [Range, Marker][];
	addMarkerSuppression(uri: URI, range: Range): IDisposable;
}
