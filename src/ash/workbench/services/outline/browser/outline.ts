import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import type { ObjectTreeOptions } from '../../../../base/browser/ui/tree/objectTree.js';
import type { TreeDataSource } from '../../../../base/browser/ui/tree/tree.js';
import type { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { IEditorPane } from '../../../common/editor.js';

export const enum OutlineTarget {
	OutlinePane = 1,
	Breadcrumbs = 2,
	QuickPick = 4,
}

export interface OutlineChangeEvent {
	readonly affectOnlyActiveElement?: true;
}

export interface IOutlineComparator<E> {
	compareByPosition(a: E, b: E): number;
	compareByType(a: E, b: E): number;
	compareByName(a: E, b: E): number;
}

/** The creator supplies elements and row rendering; the pane owns its tree and row lifetimes. */
export interface IOutlineListConfig<E> {
	readonly treeDataSource: TreeDataSource<IOutline<E>, E>;
	readonly options: ObjectTreeOptions<E>;
	readonly comparator: IOutlineComparator<E>;
}

export interface IOutline<E> extends IDisposable {
	readonly uri: URI | undefined;
	readonly config: IOutlineListConfig<E>;
	readonly outlineKind: string;
	readonly isEmpty: boolean;
	readonly activeElement: E | undefined;
	readonly onDidChange: Event<OutlineChangeEvent>;
	reveal(entry: E, options: IEditorOptions, sideBySide: boolean, select: boolean): Promise<void> | void;
}

export interface IOutlineCreator<P extends IEditorPane, E> {
	matches(candidate: IEditorPane): candidate is P;
	createOutline(editor: P, target: OutlineTarget, token: CancellationToken): Promise<IOutline<E> | undefined>;
}

/** Creators have heterogeneous element types, so the registry erases that type like VS Code. */
export interface IOutlineService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	canCreateOutline(editor: IEditorPane): boolean;
	createOutline(editor: IEditorPane, target: OutlineTarget, token: CancellationToken): Promise<IOutline<any> | undefined>;
	registerOutlineCreator(creator: IOutlineCreator<IEditorPane, any>): IDisposable;
}

export const IOutlineService = createDecorator<IOutlineService>('IOutlineService');
