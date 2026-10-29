import type { DesignPoint } from '../core/geometry.js';
import type { DesignPathNode } from './document.js';
import type { DesignPathContour } from './designVector.js';

/** Radius stays on the editable anchor in pixels; the two tangent points exist only in rendered geometry. */
export function roundDesignVectorCorners(contours: readonly DesignPathContour[], width: number, height: number, smoothing = 0): readonly DesignPathContour[] {
	const pixel = (p: DesignPoint): DesignPoint => ({ x: p.x * width, y: p.y * height });
	const normalized = (p: DesignPoint): DesignPoint => ({ x: p.x / width, y: p.y / height });
	const distance = (a: DesignPoint, b: DesignPoint) => Math.hypot(a.x - b.x, a.y - b.y);
	const straight = (a: DesignPathNode, b: DesignPathNode) => {
		const p = pixel(a),
			q = pixel(b),
			length = distance(p, q);
		return [a.outgoing, b.incoming].every(handle => {
			const h = pixel(handle);
			return Math.abs((h.x - p.x) * (q.y - p.y) - (h.y - p.y) * (q.x - p.x)) < 1e-7 * Math.max(1, length) && distance(p, h) + distance(h, q) < length + 1e-7;
		});
	};
	return contours.map(contour => {
		const { nodes, closed } = contour;
		const corners = nodes.map((node, i) => {
			if (!node.cornerRadius || (!closed && (i === 0 || i === nodes.length - 1))) {
				return undefined;
			}
			const before = nodes[(i + nodes.length - 1) % nodes.length],
				after = nodes[(i + 1) % nodes.length];
			if (!straight(before, node) || !straight(node, after)) {
				return undefined;
			}
			const a = pixel(before),
				p = pixel(node),
				b = pixel(after),
				left = distance(a, p),
				right = distance(b, p);
			if (Math.min(left, right) < 1e-8) {
				return undefined;
			}
			const u = { x: (a.x - p.x) / left, y: (a.y - p.y) / left },
				v = { x: (b.x - p.x) / right, y: (b.y - p.y) / right };
			const angle = Math.acos(Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y)));
			if (angle < 1e-5 || Math.PI - angle < 1e-5) {
				return undefined;
			}
			return { p, u, v, angle, trim: Math.min(node.cornerRadius / Math.tan(angle / 2), left, right) };
		});
		// Adjacent radii share the available edge instead of overlapping or changing the stored values.
		const factors = nodes.map(() => 1);
		for (let i = 0; i < nodes.length - (closed ? 0 : 1); i++) {
			const j = (i + 1) % nodes.length,
				sum = (corners[i]?.trim ?? 0) + (corners[j]?.trim ?? 0),
				length = distance(pixel(nodes[i]), pixel(nodes[j]));
			if (sum > length) {
				factors[i] = Math.min(factors[i], length / sum);
				factors[j] = Math.min(factors[j], length / sum);
			}
		}
		const smooth = nodes.map(() => smoothing);
		for (let i = 0; i < nodes.length - (closed ? 0 : 1); i++) {
			const j = (i + 1) % nodes.length,
				base = (corners[i]?.trim ?? 0) * factors[i] + (corners[j]?.trim ?? 0) * factors[j];
			const available = base > 0 ? Math.max(0, distance(pixel(nodes[i]), pixel(nodes[j])) / base - 1) : smoothing;
			smooth[i] = Math.min(smooth[i], available);
			smooth[j] = Math.min(smooth[j], available);
		}
		return {
			...contour,
			nodes: nodes.flatMap((node, i): DesignPathNode[] => {
				const corner = corners[i];
				if (!corner) {
					return [
						{
							...node,
							...(corners[(i + nodes.length - 1) % nodes.length] ? { incoming: { x: node.x, y: node.y } } : {}),
							...(corners[(i + 1) % nodes.length] ? { outgoing: { x: node.x, y: node.y } } : {}),
						},
					];
				}
				const { p, u, v, angle } = corner,
					trim = corner.trim * factors[i];
				const radius = trim * Math.tan(angle / 2),
					handle = (4 / 3) * Math.tan((Math.PI - angle) / 4) * radius;
				const a = { x: p.x + u.x * trim, y: p.y + u.y * trim },
					b = { x: p.x + v.x * trim, y: p.y + v.y * trim };
				if (smooth[i] > 1e-6) {
					// https://www.figma.com/blog/desperately-seeking-squircles/
					// Figma's construction replaces each end of the circular arc with a cubic.
					// Its first three controls are collinear (zero initial curvature); a = 2b
					// gives the visible smoothing range. Short edges consume smoothing before radius.
					const turn = Math.PI - angle,
						alpha = (smooth[i] * turn) / 2,
						extent = trim * (1 + smooth[i]);
					const sign = Math.sign(-u.x * v.y + u.y * v.x),
						normal = { x: sign * u.y, y: -sign * u.x };
					const center = { x: a.x + normal.x * radius, y: a.y + normal.y * radius };
					const rotate = (point: DesignPoint, angle: number): DesignPoint => ({
						x: center.x + (point.x - center.x) * Math.cos(angle) - (point.y - center.y) * Math.sin(angle),
						y: center.y + (point.x - center.x) * Math.sin(angle) + (point.y - center.y) * Math.cos(angle),
					});
					const start = { x: p.x + u.x * extent, y: p.y + u.y * extent },
						end = { x: p.x + v.x * extent, y: p.y + v.y * extent };
					const left = rotate(a, sign * alpha),
						right = rotate(b, -sign * alpha);
					const tangent = (point: DesignPoint) => ({
						x: (-sign * (point.y - center.y)) / radius,
						y: (sign * (point.x - center.x)) / radius,
					});
					const t1 = tangent(left),
						t2 = tangent(right),
						transition = radius * Math.tan(alpha / 2),
						arc = (4 / 3) * Math.tan((turn - 2 * alpha) / 4) * radius;
					const c1 = { x: left.x - t1.x * transition, y: left.y - t1.y * transition },
						c2 = { x: right.x + t2.x * transition, y: right.y + t2.y * transition };
					return [
						{
							...normalized(start),
							incoming: normalized(start),
							outgoing: normalized({
								x: start.x + ((c1.x - start.x) * 2) / 3,
								y: start.y + ((c1.y - start.y) * 2) / 3,
							}),
						},
						{
							...normalized(left),
							incoming: normalized(c1),
							outgoing: normalized({ x: left.x + t1.x * arc, y: left.y + t1.y * arc }),
						},
						{
							...normalized(right),
							incoming: normalized({ x: right.x - t2.x * arc, y: right.y - t2.y * arc }),
							outgoing: normalized(c2),
						},
						{
							...normalized(end),
							incoming: normalized({
								x: end.x + ((c2.x - end.x) * 2) / 3,
								y: end.y + ((c2.y - end.y) * 2) / 3,
							}),
							outgoing: normalized(end),
						},
					];
				}
				return [
					{
						...normalized(a),
						incoming: normalized(a),
						outgoing: normalized({ x: a.x - u.x * handle, y: a.y - u.y * handle }),
					},
					{
						...normalized(b),
						incoming: normalized({ x: b.x - v.x * handle, y: b.y - v.y * handle }),
						outgoing: normalized(b),
					},
				];
			}),
		};
	});
}
