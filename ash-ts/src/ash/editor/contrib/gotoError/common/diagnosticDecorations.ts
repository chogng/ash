import { Disposable } from "../../../../base/common/lifecycle.js";
import { TextDecorationCollection } from "../../../common/model/decorationCollection.js";
import { type VersionedLanguageResultStore } from "../../../common/languages/languageResultStore.js";
import { type LanguageDiagnostic, type LanguageDiagnosticResult } from "../../../common/languages/languageResults.js";

import { type URI } from "../../../../base/common/uri.js";
import { type LanguageDiagnosticsPublisher, type LanguageDiagnosticsSource } from "../../../common/languages/languageResults.js";
import { MinimapPosition, OverviewRulerLane, TrackedRangeStickiness, type IModelDecorationOptions } from '../../../common/model.js';
import { themeColorFromId } from '../../../../base/common/themables.js';
import { ColorId } from '../../../../platform/theme/common/colorTheme.js';
import { LanguageDiagnosticSeverity } from '../../../common/languages/languageResults.js';

/**
 * Projects current-version diagnostics into generic text decorations.
 *
 * The bridge observes but does not own the result store or text model. It owns
 * its projected collection and clears it whenever the store loses its result.
 */
export class LanguageDiagnosticDecorationBridge extends Disposable {
	readonly decorations: TextDecorationCollection<LanguageDiagnostic>;

	constructor(private readonly store: VersionedLanguageResultStore<LanguageDiagnosticResult>, private readonly externalSource?: LanguageDiagnosticsSource, private readonly resource?: URI, private readonly renderDecorations = true) {
		super();
		this.decorations = this._register(new TextDecorationCollection(store.textModel));
		try {
			this._register(store.onDidChange(() => this.synchronize()));
			if (externalSource) this._register(externalSource.onDidChangeDiagnostics(resource => {
				if (resource.toString() === this.resource?.toString()) this.synchronize();
			}));
			if (externalSource) this._register(store.textModel.onDidChangeContent(() => this.synchronize()));
			this.synchronize();
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	private synchronize(): void {
		const localDiagnostics = this.store.result?.value.diagnostics ?? [];
		const external = this.resource ? this.externalSource?.getDiagnostics(this.resource) : undefined;
		const externalDiagnostics = external?.revision === this.store.textModel.version ? external.diagnostics : [];
		const diagnostics = deduplicateDiagnostics([...localDiagnostics, ...externalDiagnostics]);
		this.decorations.replaceAll(diagnostics.map(diagnostic => ({
			range: diagnostic.range,
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			options: this.renderDecorations ? diagnosticDecorationOptions(diagnostic) : undefined,
			metadata: diagnostic,
		})));
	}
}

export function diagnosticDecorationOptions(diagnostic: LanguageDiagnostic): Omit<IModelDecorationOptions, 'stickiness'> {
	const hoverMessage = { value: diagnosticHoverText(diagnostic) };
	switch (diagnostic.severity) {
		case LanguageDiagnosticSeverity.Error:
			return markerOptions('squiggly-error', ColorId.errorForeground, 30, hoverMessage);
		case LanguageDiagnosticSeverity.Warning:
			return markerOptions('squiggly-warning', ColorId.warningForeground, 20, hoverMessage);
		case LanguageDiagnosticSeverity.Information:
			return markerOptions('squiggly-info', ColorId.accentForeground, 10, hoverMessage);
		case LanguageDiagnosticSeverity.Hint:
			return {
				description: 'marker-decoration',
				className: 'squiggly-hint',
				showIfCollapsed: true,
				hoverMessage,
				zIndex: 0,
			};
	}
}

function markerOptions(className: string, colorId: string, zIndex: number, hoverMessage: { readonly value: string }): Omit<IModelDecorationOptions, 'stickiness'> {
	const color = themeColorFromId(colorId);
	return {
		description: 'marker-decoration',
		className,
		showIfCollapsed: true,
		hoverMessage,
		overviewRuler: { color, position: OverviewRulerLane.Right },
		minimap: { color, position: MinimapPosition.Inline },
		zIndex,
	};
}

function diagnosticHoverText(diagnostic: LanguageDiagnostic): string {
	const prefix = [diagnostic.source, diagnostic.code].filter(value => value !== undefined).join(' ');
	return prefix.length === 0 ? diagnostic.message : `${prefix}: ${diagnostic.message}`;
}

/** Publishes the local syntax worker's current revision into the shared diagnostic repository. */
export class LanguageDiagnosticPublisherBridge extends Disposable {
	constructor(private readonly store: VersionedLanguageResultStore<LanguageDiagnosticResult>, private readonly publisher: LanguageDiagnosticsPublisher) {
		super();
		this._register(publisher);
		this._register(store.onDidChange(() => this.synchronize()));
		this.synchronize();
	}

	private synchronize(): void {
		const result = this.store.result;
		this.publisher.update(result?.modelVersion ?? this.store.textModel.version, result?.value.diagnostics ?? []);
	}
}

function deduplicateDiagnostics(diagnostics: readonly LanguageDiagnostic[]): readonly LanguageDiagnostic[] {
	const seen = new Set<string>();
	return diagnostics.filter(diagnostic => {
		const range = diagnostic.range;
		const key = `${range.getStartPosition().lineNumber}:${range.getStartPosition().column}:${range.getEndPosition().lineNumber}:${range.getEndPosition().column}:${diagnostic.severity}:${diagnostic.message}:${diagnostic.source ?? ""}:${diagnostic.code ?? ""}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
