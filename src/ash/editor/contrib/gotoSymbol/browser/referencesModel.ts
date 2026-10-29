import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { extUri, basename } from '../../../../base/common/resources.js';
import { type URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { type LocationLink } from '../../../common/languages.js';
import { Range, type IRange } from '../../../common/core/range.js';
import { type Position } from '../../../common/core/position.js';

export class OneReference {
	public readonly id: string;
	private currentRange: IRange;

	constructor(public readonly isProviderFirst: boolean, public readonly parent: FileReferences, public readonly link: LocationLink, private readonly rangeCallback: (reference: OneReference) => void) {
		this.id = `${parent.uri.toString()}#${parent.children.length}`;
		this.currentRange = link.targetSelectionRange ?? link.range;
	}

	public get uri(): URI { return this.link.uri; }
	public get range(): IRange { return this.currentRange; }
	public set range(value: IRange) {
		if (Range.equalsRange(value, this.currentRange)) { return; }
		this.currentRange = Range.lift(value);
		this.rangeCallback(this);
	}
	public get ariaMessage(): string {
		return localize('references.referenceLabel', '{0}, line {1}, column {2}', basename(this.uri), this.range.startLineNumber, this.range.startColumn);
	}
}

export class FileReferences {
	public readonly children: OneReference[] = [];
	constructor(public readonly parent: ReferencesModel, public readonly uri: URI) { }
	public get ariaMessage(): string {
		return localize('references.fileLabel', '{0}, {1} results', basename(this.uri), this.children.length);
	}
}

/** Owns ordered results independently of the Peek DOM and the provider request. */
export class ReferencesModel extends Disposable {
	public readonly groups: FileReferences[] = [];
	public readonly references: OneReference[] = [];
	private readonly rangeChange = this._register(new Emitter<OneReference>());
	public readonly onDidChangeReferenceRange = this.rangeChange.event;

	constructor(private readonly links: LocationLink[], public readonly title: string) {
		super();
		const providerFirst = links[0];
		const ordered = [...links].sort((a, b) => extUri.getComparisonKey(a.uri).localeCompare(extUri.getComparisonKey(b.uri)) || Range.compareRangesUsingStarts(a.targetSelectionRange ?? a.range, b.targetSelectionRange ?? b.range));
		for (const link of ordered) {
			const previous = this.references.at(-1);
			if (previous && extUri.isEqual(previous.uri, link.uri) && Range.equalsRange(previous.range, link.targetSelectionRange ?? link.range)) { continue; }
			let group = this.groups.at(-1);
			if (!group || !extUri.isEqual(group.uri, link.uri)) {
				group = new FileReferences(this, link.uri);
				this.groups.push(group);
			}
			const reference = new OneReference(link === providerFirst, group, link, reference => this.rangeChange.fire(reference));
			group.children.push(reference);
			this.references.push(reference);
		}
	}

	public get isEmpty(): boolean { return this.references.length === 0; }
	public get ariaMessage(): string {
		return localize('references.resultCount', '{0} results in {1} files', this.references.length, this.groups.length);
	}
	public firstReference(): OneReference | undefined { return this.references.find(reference => reference.isProviderFirst) ?? this.references[0]; }
	public referenceAt(resource: URI, position: Position): OneReference | undefined {
		return this.references.find(reference => extUri.isEqual(reference.uri, resource) && Range.containsPosition(reference.range, position));
	}
	public nextOrPreviousReference(reference: OneReference, next: boolean): OneReference {
		const index = this.references.indexOf(reference);
		return this.references[(index + this.references.length + (next ? 1 : -1)) % this.references.length]!;
	}
	public nearestReference(resource: URI, position: Position): OneReference | undefined {
		const source = resource.toString();
		let best: OneReference | undefined;
		let bestPrefix = -1;
		let bestDistance = Infinity;
		for (const reference of this.references) {
			const target = reference.uri.toString();
			let prefix = 0;
			while (prefix < source.length && source[prefix] === target[prefix]) { prefix++; }
			const distance = Math.abs(reference.range.startLineNumber - position.lineNumber) * 100 + Math.abs(reference.range.startColumn - position.column);
			if (prefix > bestPrefix || prefix === bestPrefix && distance < bestDistance) {
				best = reference;
				bestPrefix = prefix;
				bestDistance = distance;
			}
		}
		return best;
	}
	public clone(): ReferencesModel { return new ReferencesModel([...this.links], this.title); }
}
