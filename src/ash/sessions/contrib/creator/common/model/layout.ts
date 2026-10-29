import type { DesignTextMeasurer } from './designText.js';
import type { DesignAutoLayout, DesignConstraint, DesignGrid, DesignGridTrack, DesignShape } from './document.js';

type Axis = 'width' | 'height';
type Frame = Extract<DesignShape, { kind: 'frame' }>;
type Dimensions = Partial<Record<Axis, number>>;
const minimumSize = 0.001;

/** Resolve at the history boundary so canvas, hit testing, files and exports share one geometry. */
export function resolveDesignLayout(shapes: readonly DesignShape[], previous: readonly DesignShape[] = [], measureText?: DesignTextMeasurer): readonly DesignShape[] {
	const before = new Map(previous.map(shape => [shape.id, shape]));
	return shapes.map(shape => layoutShape(shape, before.get(shape.id), {}, measureText));
}

function lowerBound(shape: DesignShape, axis: Axis): number {
	const padding = shape.kind === 'frame' ? shape.autoLayout?.padding : undefined;
	return Math.max(minimumSize, shape.sizeLimits?.[axis === 'width' ? 'minWidth' : 'minHeight'] ?? 0, padding ? (axis === 'width' ? padding.left + padding.right : padding.top + padding.bottom) : 0);
}

function limit(shape: DesignShape, axis: Axis, value: number): number {
	return Math.max(lowerBound(shape, axis), Math.min(value, shape.sizeLimits?.[axis === 'width' ? 'maxWidth' : 'maxHeight'] ?? Infinity));
}

function move(shape: DesignShape, x: number, y: number): DesignShape {
	if (shape.x === x && shape.y === y) {
		return shape;
	}
	return {
		...shape,
		x,
		y,
		...(shape.motion
			? {
					motion: {
						...shape.motion,
						keyframes: shape.motion.keyframes.map(frame => ({
							...frame,
							x: frame.x + x - shape.x,
							y: frame.y + y - shape.y,
						})),
					},
				}
			: {}),
	};
}

function constrain(position: number, size: number, oldSize: number, newSize: number, mode: DesignConstraint): [number, number] {
	const delta = newSize - oldSize;
	switch (mode) {
		case 'center':
			return [position + delta / 2, size];
		case 'end':
			return [position + delta, size];
		case 'stretch':
			return [position, Math.max(minimumSize, size + delta)];
		case 'scale':
			return [(position * newSize) / oldSize, Math.max(minimumSize, (size * newSize) / oldSize)];
		default:
			return [position, size];
	}
}

function layoutShape(input: DesignShape, previous?: DesignShape, imposed: Dimensions = {}, measureText?: DesignTextMeasurer): DesignShape {
	const shape = layoutContents(input, previous, imposed, measureText);
	if (shape.kind !== 'frame' && shape.kind !== 'group') {
		return shape;
	}
	// Fixed layers must leave auto layout before they can be pinned. Paint order is canonical.
	const children = shape.children.map(child =>
		shape.kind === 'frame' && shape.autoLayout && child.scrollPosition === 'fixed' && child.layoutPositioning !== 'absolute' ? { ...child, scrollPosition: 'scroll' as const } : child,
	);
	return {
		...shape,
		children: [...children.filter(child => child.scrollPosition !== 'fixed'), ...children.filter(child => child.scrollPosition === 'fixed')],
	};
}

function layoutContents(input: DesignShape, previous?: DesignShape, imposed: Dimensions = {}, measureText?: DesignTextMeasurer): DesignShape {
	const shape = {
		...input,
		width: limit(input, 'width', imposed.width ?? input.width),
		height: limit(input, 'height', imposed.height ?? input.height),
	};
	if (shape.kind === 'group') {
		return {
			...shape,
			children: resolveDesignLayout(shape.children, previous?.kind === 'group' ? previous.children : [], measureText),
		};
	}
	if (shape.kind === 'text' && measureText && shape.textAutoResize && shape.textAutoResize !== 'none') {
		const autoWidth = shape.textAutoResize === 'width' && imposed.width === undefined;
		const natural = measureText(shape, autoWidth ? undefined : shape.width);
		const width = autoWidth ? limit(shape, 'width', natural.width) : shape.width;
		const measured = autoWidth && width < natural.width ? measureText({ ...shape, textAutoResize: 'height' }, width) : natural;
		const height = measured.height;
		return {
			...shape,
			width,
			height: imposed.height === undefined ? limit(shape, 'height', height) : shape.height,
		};
	}
	if (shape.kind !== 'frame') {
		return shape;
	}
	const oldFrame = previous?.kind === 'frame' ? previous : undefined;
	const before = new Map(oldFrame?.children.map(child => [child.id, child]) ?? []);
	const layout = shape.autoLayout;
	const freeChild = (child: DesignShape, frame: Frame): DesignShape => {
		let resized = child;
		if (oldFrame && before.has(child.id) && (oldFrame.width !== frame.width || oldFrame.height !== frame.height)) {
			const [x, width] = constrain(child.x, child.width, oldFrame.width, frame.width, child.constraints?.horizontal ?? 'start');
			const [y, height] = constrain(child.y, child.height, oldFrame.height, frame.height, child.constraints?.vertical ?? 'start');
			resized = { ...move(child, x, y), width, height };
		}
		return layoutShape(resized, before.get(child.id), {}, measureText);
	};
	if (!layout) {
		return { ...shape, children: shape.children.map(child => freeChild(child, shape)) };
	}
	const visible = shape.children.filter(child => child.visible !== false && child.layoutPositioning !== 'absolute');
	const measured = visible.map(child => layoutShape(child, before.get(child.id), {}, measureText));
	// Each allocation starts from the input tree, not an already resized subtree: free-frame
	// constraints and animation offsets must be applied only once to the final dimensions.
	const resize = (index: number, size: Dimensions): DesignShape => layoutShape(visible[index], before.get(visible[index].id), size, measureText);
	const result =
		layout.direction === 'grid' && layout.grid
			? layoutGrid({ ...shape, children: visible }, layout, layout.grid, measured, imposed, resize)
			: layoutFlow({ ...shape, children: visible }, layout, measured, imposed, resize);
	const resolved = new Map(result.children.map(child => [child.id, child]));
	return {
		...result,
		children: shape.children.map(child => resolved.get(child.id) ?? (child.layoutPositioning === 'absolute' ? freeChild(child, result) : child)),
	};
}

function offset(alignment: 'start' | 'center' | 'end' | 'space-between', available: number): number {
	return alignment === 'center' ? available / 2 : alignment === 'end' ? available : 0;
}

/** Equal fill shares are reallocated when a sibling reaches a minimum or maximum. */
function allocateFill(children: readonly DesignShape[], axis: Axis, available: number): Map<DesignShape, number> {
	const result = new Map<DesignShape, number>();
	let pending = [...children];
	while (pending.length) {
		const share = available / pending.length;
		const total = pending.reduce((sum, child) => sum + limit(child, axis, share), 0);
		const frozen = pending.filter(child => (total > available ? limit(child, axis, share) > share : limit(child, axis, share) < share));
		if (!frozen.length) {
			for (const child of pending) {
				result.set(child, limit(child, axis, share));
			}
			break;
		}
		for (const child of frozen) {
			const size = limit(child, axis, share);
			result.set(child, size);
			available -= size;
		}
		pending = pending.filter(child => !result.has(child));
	}
	return result;
}

function layoutFlow(shape: Frame, layout: DesignAutoLayout, measured: readonly DesignShape[], imposed: Dimensions, resize: (index: number, size: Dimensions) => DesignShape): Frame {
	const horizontal = layout.direction === 'horizontal';
	const main: Axis = horizontal ? 'width' : 'height';
	const cross: Axis = horizontal ? 'height' : 'width';
	const pad = layout.padding;
	const mainStart = horizontal ? pad.left : pad.top;
	const crossStart = horizontal ? pad.top : pad.left;
	const mainPadding = horizontal ? pad.left + pad.right : pad.top + pad.bottom;
	const crossPadding = horizontal ? pad.top + pad.bottom : pad.left + pad.right;
	const dimensions = { width: shape.width, height: shape.height };
	const hug = (axis: Axis): boolean => layout[axis] === 'hug' && imposed[axis] === undefined;
	const fills = (child: DesignShape, axis: Axis): boolean => child.kind !== 'group' && child.sizing?.[axis] === 'fill' && !hug(axis);
	const allocations: Dimensions[] = measured.map(() => ({}));
	if (!layout.wrap && !hug(cross)) {
		measured = measured.map((child, index) => {
			if (!fills(child, cross)) {
				return child;
			}
			allocations[index][cross] = dimensions[cross] - crossPadding;
			return resize(index, allocations[index]);
		});
	}
	const naturalMain = measured.reduce((sum, child) => sum + child[main], 0) + Math.max(0, measured.length - 1) * layout.gap + mainPadding;
	if (hug(main)) {
		dimensions[main] = limit(shape, main, naturalMain);
	}
	const availableMain = Math.max(0, dimensions[main] - mainPadding);
	// Fill items wrap using their minimum, not their previous allocated width. This keeps
	// line breaking stable across repeated edits and allows them to share each new line.
	const lines: number[][] = [];
	let used = 0;
	for (let index = 0; index < measured.length; index++) {
		const basis = fills(measured[index], main) ? lowerBound(measured[index], main) : measured[index][main];
		let line = lines.at(-1);
		if (!line || (layout.wrap && line.length > 0 && used + layout.gap + basis > availableMain + 1e-9)) {
			line = [];
			lines.push(line);
			used = 0;
		}
		used += (line.length ? layout.gap : 0) + basis;
		line.push(index);
	}
	const children = [...measured];
	for (const line of lines) {
		const filling = line.map(index => measured[index]).filter(child => fills(child, main));
		const fixed = line.reduce((sum, index) => sum + (fills(measured[index], main) ? 0 : measured[index][main]), 0);
		const allocated = allocateFill(filling, main, availableMain - fixed - Math.max(0, line.length - 1) * layout.gap);
		for (const index of line) {
			const size = allocated.get(measured[index]);
			if (size !== undefined) {
				allocations[index][main] = size;
				children[index] = resize(index, allocations[index]);
			}
		}
	}
	const crossGap = layout.crossGap ?? layout.gap;
	const lineSizes = lines.map(line => Math.max(0, ...line.map(index => children[index][cross])));
	const naturalCross = lineSizes.reduce((sum, size) => sum + size, 0) + Math.max(0, lines.length - 1) * crossGap + crossPadding;
	if (hug(cross)) {
		dimensions[cross] = limit(shape, cross, naturalCross);
	}
	// No-wrap has one line spanning the content box. Wrapped lines retain their content
	// size, with the complete line stack aligned inside the frame (CSS align-content).
	if (!layout.wrap && lineSizes.length) {
		lineSizes[0] = dimensions[cross] - crossPadding;
	}
	let crossCursor = crossStart + (layout.wrap ? offset(layout.align, dimensions[cross] - naturalCross) : 0);
	for (const [lineIndex, line] of lines.entries()) {
		for (const index of line) {
			if (fills(children[index], cross)) {
				allocations[index][cross] = lineSizes[lineIndex];
				children[index] = resize(index, allocations[index]);
			}
		}
		const remaining = Math.max(0, availableMain - Math.max(0, line.length - 1) * layout.gap - line.reduce((sum, index) => sum + children[index][main], 0));
		let cursor = mainStart + offset(layout.justify, remaining);
		const gap = layout.gap + (layout.justify === 'space-between' && line.length > 1 ? remaining / (line.length - 1) : 0);
		for (const index of line) {
			const child = children[index];
			const crossPosition = crossCursor + offset(layout.align, lineSizes[lineIndex] - child[cross]);
			children[index] = move(child, horizontal ? cursor : crossPosition, horizontal ? crossPosition : cursor);
			cursor += child[main] + gap;
		}
		crossCursor += lineSizes[lineIndex] + crossGap;
	}
	return { ...shape, ...dimensions, children };
}

/** Shared with HTML export; positions are zero-based, spans include occupied gaps. */
export function getDesignGridCells(children: readonly DesignShape[], grid: DesignGrid): { column: number; row: number; columnSpan: number; rowSpan: number }[] {
	const columns = grid.columns.length;
	const occupied = new Map<number, Set<number>>();
	let cursor = 0;
	return children.map(child => {
		const columnSpan = Math.min(columns, child.gridCell?.columnSpan ?? 1);
		const rowSpan = child.gridCell?.rowSpan ?? 1;
		const manual = grid.positioning === 'manual' && (child.gridCell?.column !== undefined || child.gridCell?.row !== undefined);
		let cell = manual ? ((child.gridCell?.row ?? 1) - 1) * columns + Math.min(columns - columnSpan, (child.gridCell?.column ?? 1) - 1) : cursor;
		const fits = (): boolean => {
			if ((cell % columns) + columnSpan > columns) {
				return false;
			}
			for (let row = Math.floor(cell / columns); row < Math.floor(cell / columns) + rowSpan; row++) {
				for (let column = cell % columns; column < (cell % columns) + columnSpan; column++) {
					if (occupied.get(row)?.has(column)) {
						return false;
					}
				}
			}
			return true;
		};
		while (!fits()) {
			cell++;
		}
		const row = Math.floor(cell / columns);
		const column = cell % columns;
		for (let y = row; y < row + rowSpan; y++) {
			let cells = occupied.get(y);
			if (!cells) {
				cells = new Set();
				occupied.set(y, cells);
			}
			for (let x = column; x < column + columnSpan; x++) {
				cells.add(x);
			}
		}
		if (!manual) {
			cursor = cell + columnSpan;
		}
		return { column, row, columnSpan, rowSpan };
	});
}

function trackSizes(tracks: readonly DesignGridTrack[], contributions: readonly { start: number; span: number; size: number }[], gap: number, available?: number): number[] {
	const sizes = tracks.map(track => (track.sizing === 'fixed' ? track.value : 0));
	// Single-cell contributions establish track minima before spanning items distribute
	// their remaining content over flexible tracks. Fixed tracks never grow implicitly.
	for (const item of [...contributions].sort((a, b) => a.span - b.span)) {
		const indices = Array.from({ length: item.span }, (_, index) => item.start + index);
		const extra = item.size - (item.span - 1) * gap - indices.reduce((sum, index) => sum + sizes[index], 0);
		const flexible = indices.filter(index => tracks[index].sizing !== 'fixed');
		if (extra > 0 && flexible.length) {
			for (const index of flexible) {
				sizes[index] += extra / flexible.length;
			}
		}
	}
	const fractions = tracks.reduce((sum, track) => sum + (track.sizing === 'fill' ? track.value : 0), 0);
	if (fractions) {
		const fraction =
			available === undefined
				? Math.max(0, ...tracks.map((track, index) => (track.sizing === 'fill' ? sizes[index] / track.value : 0)))
				: Math.max(0, available - Math.max(0, tracks.length - 1) * gap - tracks.reduce((sum, track, index) => sum + (track.sizing === 'fill' ? 0 : sizes[index]), 0)) / fractions;
		for (const [index, track] of tracks.entries()) {
			if (track.sizing === 'fill') {
				sizes[index] = fraction * track.value;
			}
		}
	}
	return sizes;
}

function layoutGrid(shape: Frame, layout: DesignAutoLayout, grid: DesignGrid, measured: readonly DesignShape[], imposed: Dimensions, resize: (index: number, size: Dimensions) => DesignShape): Frame {
	const cells = getDesignGridCells(measured, grid);
	const rowCount = Math.max(grid.autoRows ? 0 : grid.rows.length, ...cells.map(cell => cell.row + cell.rowSpan));
	const rows = Array.from({ length: rowCount }, (_, index) => grid.rows[index] ?? ({ sizing: 'fill', value: 1 } as const));
	const pad = layout.padding;
	const rowGap = layout.crossGap ?? layout.gap;
	const dimensions = { width: shape.width, height: shape.height };
	const children = [...measured];
	const sizes = (axis: Axis, tracks: readonly DesignGridTrack[], gap: number, padding: number): number[] => {
		const contributions = cells.map((cell, index) => ({
			start: axis === 'width' ? cell.column : cell.row,
			span: axis === 'width' ? cell.columnSpan : cell.rowSpan,
			size: children[index][axis],
		}));
		if (layout[axis] === 'hug' && imposed[axis] === undefined) {
			const natural = trackSizes(tracks, contributions, gap);
			dimensions[axis] = limit(shape, axis, natural.reduce((sum, size) => sum + size, 0) + Math.max(0, tracks.length - 1) * gap + padding);
		}
		return trackSizes(tracks, contributions, gap, dimensions[axis] - padding);
	};
	const spanSize = (tracks: readonly number[], start: number, span: number, gap: number): number => tracks.slice(start, start + span).reduce((sum, size) => sum + size, 0) + (span - 1) * gap;
	const tracks: Record<Axis, number[]> = { width: [], height: [] };
	const allocated: Dimensions[] = children.map(() => ({}));
	// Resolve the definite dimension first, so nested horizontal or vertical wrapping
	// can report its new content size before the other dimension hugs it.
	const axes: Axis[] = layout.width === 'hug' && imposed.width === undefined && (layout.height === 'fixed' || imposed.height !== undefined) ? ['height', 'width'] : ['width', 'height'];
	for (const axis of axes) {
		const horizontal = axis === 'width';
		const gap = horizontal ? layout.gap : rowGap;
		tracks[axis] = sizes(axis, horizontal ? grid.columns : rows, gap, horizontal ? pad.left + pad.right : pad.top + pad.bottom);
		for (const [index, cell] of cells.entries()) {
			if (children[index].kind !== 'group' && children[index].sizing?.[axis] === 'fill') {
				allocated[index][axis] = spanSize(tracks[axis], horizontal ? cell.column : cell.row, horizontal ? cell.columnSpan : cell.rowSpan, gap);
				children[index] = resize(index, allocated[index]);
			}
		}
	}
	const columns = tracks.width;
	const heights = tracks.height;
	for (const [index, cell] of cells.entries()) {
		const width = spanSize(columns, cell.column, cell.columnSpan, layout.gap);
		const height = spanSize(heights, cell.row, cell.rowSpan, rowGap);
		const child = children[index];
		const x = pad.left + columns.slice(0, cell.column).reduce((sum, size) => sum + size, 0) + cell.column * layout.gap + offset(child.gridCell?.horizontal ?? 'start', width - child.width);
		const y = pad.top + heights.slice(0, cell.row).reduce((sum, size) => sum + size, 0) + cell.row * rowGap + offset(child.gridCell?.vertical ?? 'start', height - child.height);
		children[index] = move(child, x, y);
	}
	return { ...shape, ...dimensions, children };
}
