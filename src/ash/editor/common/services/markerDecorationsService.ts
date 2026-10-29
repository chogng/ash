import { TextModel } from '../model/textModel.js';
import { LanguageDiagnosticSeverity, type LanguageDiagnostic, type LanguageDiagnosticsSource } from '../languages.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { type URI } from '../../../base/common/uri.js';
import { IMarkerService, MarkerSeverity, type IMarker } from '../../../platform/markers/common/markers.js';
import { Range } from '../core/range.js';
import {
	type IModelDecoration,
	type IModelDeltaDecoration,
	type ITextModel,
	TrackedRangeStickiness,
	OverviewRulerLane,
	MinimapPosition,
} from '../model.js';
import { type IMarkerDecorationsService, type IMarkerLimit } from './markerDecorations.js';
import { themeColorFromId } from '../../../base/common/themables.js';
import {
	accentForeground,
	errorForeground,
	warningForeground,
} from '../../../platform/theme/common/colors/baseColors.js';

interface ModelMarkers {
	readonly store: DisposableStore;
	readonly diagnostics: LanguageDiagnosticsSource | undefined;
	readonly suppressions: Set<string>;
	references: number;
	updating: boolean;
	owned: string[];
	markers: Map<string, IMarker>;
	signature: string;
	limit: IMarkerLimit | undefined;
}

/** Owns marker decorations once per model, shared by all attached editors. */
export class MarkerDecorationsService extends Disposable implements IMarkerDecorationsService {
	readonly _serviceBrand = undefined;
	private readonly models = new Map<ITextModel, ModelMarkers>();
	private readonly changed = this._register(new Emitter<ITextModel>());
	readonly onDidChangeMarker = this.changed.event;
	private readonly limitChanged = this._register(new Emitter<ITextModel>());
	readonly onDidChangeMarkerLimit = this.limitChanged.event;

	constructor(@IMarkerService private readonly markerService: IMarkerService) {
		super();
		this._register(
			markerService.onMarkerChanged(event => {
				for (const [model, state] of this.models) {
					if (event.some(resource => resource.toString() === model.uri.toString()))
						this.synchronize(model, state, true);
				}
			}),
		);
	}

	acquire(model: ITextModel, diagnostics?: LanguageDiagnosticsSource): IDisposable {
		this.assertNotDisposed();
		let state = this.models.get(model);
		if (!state) {
			state = {
				diagnostics,
				store: new DisposableStore(),
				suppressions: new Set(),
				references: 0,
				updating: false,
				owned: [],
				markers: new Map(),
				signature: '',
				limit: undefined,
			};
			this.models.set(model, state);
			const current = state;
			if (model instanceof TextModel) {
				state.store.add(model.diagnostics.results.onDidChange(() => this.synchronize(model, current, true)));
			}
			if (diagnostics)
				state.store.add(
					diagnostics.onDidChangeDiagnostics(uri => {
						if (uri.toString() === model.uri.toString()) this.synchronize(model, current, true);
					}),
				);
			state.store.add(model.onWillDispose(() => this.remove(model, current)));
			state.store.add(model.onDidChangeDecorations(() => this.synchronize(model, current, false)));
			this.synchronize(model, state, true);
		}
		state.references++;
		const current = state;
		return toDisposable(() => {
			if (--current.references === 0) this.remove(model, current);
		});
	}

	getMarker(uri: URI, decoration: IModelDecoration): IMarker | null {
		return this.find(uri)?.[1].markers.get(decoration.id) ?? null;
	}

	getMarkerLimits(uri: URI): IMarkerLimit | undefined {
		return this.find(uri)?.[1].limit;
	}

	getLiveMarkers(uri: URI): [Range, IMarker][] {
		const found = this.find(uri);
		if (!found) return [];
		const [model, state] = found;
		const result: [Range, IMarker][] = [];
		for (const [id, marker] of state.markers) {
			const range = model.getDecorationRange(id);
			if (range && !this.isSuppressed(model, state, range)) result.push([range, marker]);
		}
		return result;
	}

	addMarkerSuppression(uri: URI, range: Range): IDisposable {
		const found = this.find(uri);
		if (!found) return Disposable.None;
		const [model, state] = found;
		const id = model._setTrackedRange(
			null,
			model.validateRange(range),
			TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		);
		state.suppressions.add(id);
		this.synchronize(model, state, false);
		return toDisposable(() => {
			if (!state.suppressions.delete(id)) return;
			model._setTrackedRange(id, null, TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges);
			this.synchronize(model, state, false);
		});
	}

	private find(uri: URI): [ITextModel, ModelMarkers] | undefined {
		return [...this.models].find(([model]) => model.uri.toString() === uri.toString());
	}

	private isSuppressed(model: ITextModel, state: ModelMarkers, range: Range): boolean {
		return [...state.suppressions].some(id => {
			const suppression = model._getTrackedRange(id);
			return suppression !== null && Range.areIntersecting(suppression, range);
		});
	}

	private synchronize(model: ITextModel, state: ModelMarkers, resetRanges: boolean): void {
		if (state.updating || this.models.get(model) !== state || model.isDisposed()) return;
		state.updating = true;
		try {
			const tracked = new Map([...state.markers].map(([id, marker]) => [marker, model.getDecorationRange(id)]));
			const decorations: IModelDeltaDecoration[] = [];
			const markers: IMarker[] = [];
			const values = [...this.markerService.read({ resource: model.uri })];
			const local = model instanceof TextModel ? (model.diagnostics.results.result?.value.diagnostics ?? []) : [];
			const external = state.diagnostics?.getDiagnostics(model.uri);
			const diagnostics = [
				...local,
				...(external?.revision === model.getVersionId() ? external.diagnostics : []),
			];
			values.push(...diagnostics.map(diagnostic => diagnosticMarker(model, diagnostic)));
			const seen = new Set<string>();
			let count = 0;
			// Keep the most severe diagnostics visible within the editor budget.
			values.sort((a, b) => b.severity - a.severity);
			for (const marker of values) {
				const key = JSON.stringify([
					marker.startLineNumber,
					marker.startColumn,
					marker.endLineNumber,
					marker.endColumn,
					marker.severity,
					marker.message,
					marker.source,
					marker.code,
				]);
				if (seen.has(key)) continue;
				seen.add(key);
				if (++count > 5000) continue;
				const range =
					(!resetRanges && tracked.get(marker)) ||
					model.validateRange(
						new Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn),
					);
				const suppressed = this.isSuppressed(model, state, range);
				decorations.push({
					range,
					options: suppressed
						? {
								description: 'suppressed-marker',
								stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
							}
						: markerOptions(marker),
				});
				markers.push(marker);
			}
			const sourceTruncated = this.markerService.isSourceTruncated(model.uri);
			const decorationLimit = count > 5000 ? 5000 : undefined;
			if (
				sourceTruncated !== (state.limit?.isMarkersSourceTruncated ?? false) ||
				decorationLimit !== state.limit?.isMarkersTruncated
			) {
				state.limit =
					sourceTruncated || decorationLimit !== undefined
						? { isMarkersSourceTruncated: sourceTruncated, isMarkersTruncated: decorationLimit }
						: undefined;
				this.limitChanged.fire(model);
			}
			const signature = JSON.stringify(decorations);
			if (signature === state.signature && !resetRanges) return;
			state.signature = signature;
			state.owned = model.deltaDecorations(state.owned, decorations);
			state.markers = new Map(state.owned.map((id, index) => [id, markers[index]]));
		} finally {
			state.updating = false;
		}
		this.changed.fire(model);
	}

	private remove(model: ITextModel, state: ModelMarkers): void {
		if (this.models.get(model) !== state) return;
		this.models.delete(model);
		state.store.dispose();
		if (!model.isDisposed()) {
			model.deltaDecorations(state.owned, []);
			for (const id of state.suppressions)
				model._setTrackedRange(id, null, TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges);
		}
		state.suppressions.clear();
		state.markers.clear();
		if (state.limit) this.limitChanged.fire(model);
	}

	protected override disposeCore(): void {
		for (const [model, state] of this.models) this.remove(model, state);
		super.disposeCore();
	}
}

function markerOptions(marker: IMarker): IModelDeltaDecoration['options'] {
	const colorId =
		marker.severity === MarkerSeverity.Error
			? errorForeground
			: marker.severity === MarkerSeverity.Warning
				? warningForeground
				: accentForeground;
	const color = themeColorFromId(colorId);
	const severity = {
		[MarkerSeverity.Error]: 'error',
		[MarkerSeverity.Warning]: 'warning',
		[MarkerSeverity.Info]: 'info',
		[MarkerSeverity.Hint]: 'hint',
	}[marker.severity];
	const code = typeof marker.code === 'object' ? marker.code.value : marker.code;
	const prefix = [marker.source, code].filter(value => value !== undefined).join(' ');
	return {
		description: 'marker-decoration',
		className: `squiggly-${severity}`,
		hoverMessage: { value: prefix ? `${prefix}: ${marker.message}` : marker.message },
		showIfCollapsed: true,
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		overviewRuler: { color, position: OverviewRulerLane.Right },
		minimap: { color, position: MinimapPosition.Inline },
	};
}

function diagnosticMarker(model: ITextModel, diagnostic: LanguageDiagnostic): IMarker {
	return {
		owner: 'editor-language',
		resource: model.uri,
		startLineNumber: diagnostic.range.startLineNumber,
		startColumn: diagnostic.range.startColumn,
		endLineNumber: diagnostic.range.endLineNumber,
		endColumn: diagnostic.range.endColumn,
		severity: {
			[LanguageDiagnosticSeverity.Error]: MarkerSeverity.Error,
			[LanguageDiagnosticSeverity.Warning]: MarkerSeverity.Warning,
			[LanguageDiagnosticSeverity.Information]: MarkerSeverity.Info,
			[LanguageDiagnosticSeverity.Hint]: MarkerSeverity.Hint,
		}[diagnostic.severity],
		message: diagnostic.message,
		source: diagnostic.source,
		...(diagnostic.code === undefined ? {} : { code: String(diagnostic.code) }),
	};
}
