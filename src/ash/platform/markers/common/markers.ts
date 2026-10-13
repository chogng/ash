import { type Event } from '../../../base/common/event.js';
import { type URI } from '../../../base/common/uri.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/** Severity used by resource markers. */
export enum MarkerSeverity {
	Hint = 1,
	Info = 2,
	Warning = 4,
	Error = 8,
}

export const enum MarkerTag {
	Unnecessary = 1,
	Deprecated = 2,
}

export interface IRelatedInformation {
	resource: URI;
	message: string;
	startLineNumber: number;
	startColumn: number;
	endLineNumber: number;
	endColumn: number;
}

/** Diagnostic data uses one-based lines and UTF-16 columns, like editor ranges. */
export interface IMarkerData {
	code?: string | { value: string; target: URI; };
	severity: MarkerSeverity;
	message: string;
	source?: string;
	startLineNumber: number;
	startColumn: number;
	endLineNumber: number;
	endColumn: number;
	modelVersionId?: number;
	relatedInformation?: IRelatedInformation[];
	tags?: MarkerTag[];
	origin?: string;
}

export interface IResourceMarker {
	resource: URI;
	marker: IMarkerData;
}

/** The service assigns ownership; decoration identifiers remain editor-owned. */
export interface IMarker extends IMarkerData {
	owner: string;
	resource: URI;
}

export interface IMarkerReadOptions {
	owner?: string;
	resource?: URI;
	severities?: number;
	take?: number;
}

export interface MarkerStatistics {
	errors: number;
	warnings: number;
	infos: number;
	unknowns: number;
}

/** Window-scoped aggregation shared by diagnostics producers and UI consumers. */
export interface IMarkerService {
	readonly _serviceBrand: undefined;
	readonly onMarkerChanged: Event<readonly URI[]>;

	getStatistics(): MarkerStatistics;
	changeOne(owner: string, resource: URI, markers: IMarkerData[]): void;
	changeAll(owner: string, data: IResourceMarker[]): void;
	remove(owner: string, resources: URI[]): void;
	read(filter?: IMarkerReadOptions): IMarker[];
}

export const IMarkerService = createDecorator<IMarkerService>('markerService');
