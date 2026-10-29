import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import { raceCancellationError } from '../../../base/common/async.js';
import type { ISyntaxApi, SyntaxRange } from '../common/syntaxApi.js';
import { Event } from '../../../base/common/event.js';

export function createDisconnectedSyntaxApi(unavailable: UnavailableOperation): ISyntaxApi {
	return {
		generation: 0,
		isAvailable: false,
		onDidChangeConnection: Event.None,
		open: () => unavailable('syntax.open'),
		update: () => unavailable('syntax.update'),
		query: () => unavailable('syntax.query'),
		analyze: () => unavailable('syntax.analyze'),
		selectionRanges: () => unavailable('syntax.selectionRanges'),
		close: () => unavailable('syntax.close'),
	};
}

export function createAppServerSyntaxApi(connection: AppServerProtocolClient): ISyntaxApi {
	let operation = 0;
	return {
		get generation() {
			return connection.generation;
		},
		get isAvailable() {
			return connection.state === 'ready';
		},
		onDidChangeConnection: (listener, thisArgs, disposables) => {
			let available = connection.state === 'ready';
			const subscription = connection.onStateChange(state => {
				const next = state === 'ready';
				if (next === available) return;
				available = next;
				listener.call(thisArgs, undefined);
			});
			if (Array.isArray(disposables)) disposables.push(subscription);
			else disposables?.add(subscription);
			return subscription;
		},
		open: async (params, analysis) => {
			await appServerRequest(connection, analysis === 'shared' ? 'syntax/openShared' : 'syntax/open', params);
		},
		update: async params => {
			await appServerRequest(connection, 'syntax/update', { ...params, edits: [...params.edits] });
		},
		query: async (params, signal) => {
			signal.throwIfAborted();
			const generation = connection.generation;
			const operationId = `syntax-query-${generation}-${++operation}`;
			const cancel = (): void => {
				if (connection.generation === generation && connection.state === 'ready') {
					void appServerRequest(connection, 'syntax/cancel', { operationId }).catch(() => undefined);
				}
			};
			signal.addEventListener('abort', cancel, { once: true });
			try {
				const request = appServerRequest(connection, 'syntax/query', {
					...params,
					operationId,
					factsRevision: params.factsRevision ?? null,
					factsTabSize: params.factsTabSize ?? null,
					ranges: [...params.ranges],
					lineIndex: params.lineIndex ?? null,
					lines: [...params.lines],
				});
				const result = await raceCancellationError(request, signal, 'Syntax query cancelled');
				const facts = result.facts;
				return {
					...result,
					facts: facts
						? {
								baseRevision: facts.baseRevision,
								edits: facts.edits.map(edit => ({
									range: tupleRange(edit.slice(0, 4)),
									end: { lineIndex: edit[4], columnIndex: edit[5] },
								})),
								symbols: {
									...facts.symbols,
									items: facts.symbols.items.map(([name, kind, range, selectionRange]) => ({
										name,
										kind,
										range: tupleRange(range),
										selectionRange: tupleRange(selectionRange),
									})),
								},
								folds: {
									...facts.folds,
									items: facts.folds.items.map(([startLineIndex, endLineIndex, kind]) => {
										if (kind !== null && kind !== 'comment' && kind !== 'region')
											throw new TypeError('Invalid syntax fold category');
										return { startLineIndex, endLineIndex, ...(kind ? { kind } : {}) };
									}),
								},
								diagnostics: {
									...facts.diagnostics,
									items: facts.diagnostics.items.map(([range, kind]) => ({
										range: tupleRange(range),
										kind,
									})),
								},
							}
						: null,
				};
			} finally {
				signal.removeEventListener('abort', cancel);
			}
		},
		analyze: params => appServerRequest(connection, 'syntax/analyze', params),
		selectionRanges: params =>
			appServerRequest(connection, 'syntax/selectionRanges', { ...params, ranges: [...params.ranges] }),
		close: async params => {
			await appServerRequest(connection, 'syntax/close', params);
		},
	};
}

function tupleRange(range: readonly number[]): SyntaxRange {
	return {
		start: { lineIndex: range[0]!, columnIndex: range[1]! },
		end: { lineIndex: range[2]!, columnIndex: range[3]! },
	};
}
