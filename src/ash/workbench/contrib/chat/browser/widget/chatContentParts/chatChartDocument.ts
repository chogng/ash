import { htmlAttributeEncodeValue as escapeHTML } from '../../../../../../base/common/strings.js';
import { isRecord } from '../../../../../../base/common/types.js';
import { localize } from '../../../../../../nls.js';

/** Builds the interactive preview for a response resource that carries chart data. */
export function renderChatChartDocument(title: string, json: string): string | undefined {
	let data: unknown;
	try { data = JSON.parse(json); }
	catch { return undefined; }
	let rows: unknown[] = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.data) ? data.data : [];
	if (isRecord(data) && Array.isArray(data.labels) && Array.isArray(data.datasets)) {
		const datasets = data.datasets.filter(isRecord);
		rows = data.labels.map((label, index) => Object.fromEntries([
			['label', label],
			...datasets.map((dataset, series) => [typeof dataset.label === 'string' ? dataset.label : String(series + 1), Array.isArray(dataset.data) ? dataset.data[index] : null]),
		]));
	}
	const table = rows.map((row, index) => isRecord(row) ? row : { index: index + 1, value: row });
	const keys = [...new Set(table.flatMap(row => Object.keys(row)))];
	const content = JSON.stringify({ rows: table, keys }).replaceAll('<', '\\u003c');
	return `<!doctype html>
<html>
<meta charset="utf-8">
<style>body{font:14px system-ui;color:CanvasText;background:Canvas;margin:16px}canvas{width:100%;height:280px}fieldset{border:0;padding:0;display:flex;gap:12px;flex-wrap:wrap}table{border-collapse:collapse}td,th{padding:8px;border:1px solid GrayText}button,select,input{font:inherit}output{display:block;min-height:2em}</style>
<h3>${escapeHTML(title)}</h3>
<fieldset>
<label>${escapeHTML(localize('chat.chart.type', 'Chart type'))} <select id="type">
<option value="bar">${escapeHTML(localize('chat.chart.bar', 'Bar'))}</option>
<option value="line">${escapeHTML(localize('chat.chart.line', 'Line'))}</option>
</select>
</label>
<label>${escapeHTML(localize('chat.chart.zoom', 'Zoom'))} <input aria-label="${escapeHTML(localize('chat.chart.zoom', 'Zoom'))}" id="zoom" type="range" min="1" max="4" step="0.25" value="1">
</label>
<span id="series">
</span>
<button id="previous">${escapeHTML(localize('chat.chart.previous', 'Previous'))}</button>
<output id="page"></output>
<button id="next">${escapeHTML(localize('chat.chart.next', 'Next'))}</button>
</fieldset>
<canvas id="chart" role="img" aria-label="${escapeHTML(title)}" tabindex="0">
</canvas>
<output id="point" aria-live="polite">
</output>
<details open>
<summary>${escapeHTML(localize('chat.chart.data', 'Chart data'))}</summary>
<table>
<thead>
<tr>${keys.map(key => `<th>${escapeHTML(key)}</th>`).join('')}</tr>
</thead>
<tbody id="rows"></tbody>
</table>
</details>
<details><summary>${escapeHTML(localize('chat.chart.originalData', 'Original data'))}</summary><pre>${escapeHTML(json)}</pre></details><script>
(() => {
  const data = ${content};
  const canvas = document.getElementById('chart');
  const context = canvas.getContext('2d');
  const numeric = data.keys.filter(key => data.rows.some(row => typeof row[key] === 'number'));
  const label = data.keys.find(key => !numeric.includes(key)) ?? (data.keys.length > 1 ? data.keys[0] : undefined);
  const series = numeric.filter(key => key !== label);
  const enabled = new Set(series);
  const type = document.getElementById('type');
  const zoom = document.getElementById('zoom');
  const point = document.getElementById('point');
  let selected = 0;
  let page = 0;
  let frame;
  const pageSize = 100;
  for (const key of series) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.onchange = () => {
      box.checked ? enabled.add(key) : enabled.delete(key);
      scheduleDraw();
    };
    const item = document.createElement('label');
    item.append(box, key);
    document.getElementById('series').append(item);
  }
  function describe(index) {
    const row = data.rows[index];
    point.textContent = row ? data.keys.map(key => key + ': ' + String(row[key] ?? '')).join(' · ') : '';
  }
  function pageRows() {
    return data.rows.slice(page * pageSize, (page + 1) * pageSize);
  }
  function renderPage() {
    document.getElementById('previous').disabled = page === 0;
    document.getElementById('next').disabled = (page + 1) * pageSize >= data.rows.length;
    document.getElementById('page').textContent = (page + 1) + '/' + Math.max(1, Math.ceil(data.rows.length / pageSize));
    document.getElementById('rows').replaceChildren(...pageRows().map(row => {
      const tr = document.createElement('tr');
      for (const key of data.keys) {
        const td = document.createElement('td');
        td.textContent = row[key] && typeof row[key] === 'object' ? JSON.stringify(row[key]) : String(row[key] ?? '');
        tr.append(td);
      }
      return tr;
    }));
    describe(selected);
    scheduleDraw();
  }
  function scheduleDraw() {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => { frame = undefined; draw(); });
  }
  function draw() {
    const rows = pageRows();
    const width = Math.max(1, canvas.clientWidth);
    const pixelWidth = Math.round(width * devicePixelRatio);
    const pixelHeight = Math.round(280 * devicePixelRatio);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    const active = series.filter(key => enabled.has(key));
    const maximum = rows.reduce((max, row) => active.reduce((max, key) => Math.max(max, Math.abs(Number(row[key]) || 0)), max), 1);
    context.clearRect(0, 0, width, 280);
    context.fillStyle = getComputedStyle(document.body).color;
    context.font = '12px system-ui';
    const slot = Math.max(1, width - 60) / Math.max(1, rows.length);
    active.forEach((key, seriesIndex) => {
      context.strokeStyle = context.fillStyle = 'hsl(' + ((seriesIndex * 137 + 210) % 360) + ' 65% 48%)';
      context.beginPath();
      rows.forEach((row, index) => {
        const value = Number(row[key]) || 0;
        const x = 40 + index * slot;
        const y = 240 - value / maximum * 190 * Number(zoom.value);
        if (type.value === 'bar') {
          context.fillRect(x + seriesIndex * slot / Math.max(1, active.length), Math.min(y, 240), Math.max(1, slot / Math.max(1, active.length) - 4), Math.abs(240 - y));
        } else {
          index ? context.lineTo(x + slot / 2, y) : context.moveTo(x + slot / 2, y);
        }
      });
      if (type.value === 'line') context.stroke();
    });
    context.fillStyle = getComputedStyle(document.body).color;
    rows.forEach((row, index) => context.fillText(String(row[label] ?? index + page * pageSize + 1).slice(0, 16), 40 + index * slot, 260));
  }
  type.onchange = zoom.oninput = scheduleDraw;
  document.getElementById('previous').onclick = () => { page--; selected = page * pageSize; renderPage(); };
  document.getElementById('next').onclick = () => { page++; selected = page * pageSize; renderPage(); };
  canvas.onpointermove = event => {
    const count = Math.min(pageSize, data.rows.length - page * pageSize);
    const slot = Math.max(1, canvas.clientWidth - 60) / Math.max(1, count);
    selected = page * pageSize + Math.max(0, Math.min(count - 1, Math.floor((event.offsetX - 40) / slot)));
    describe(selected);
  };
  canvas.onkeydown = event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      selected = Math.max(0, Math.min(data.rows.length - 1, selected + (event.key === 'ArrowLeft' ? -1 : 1)));
      describe(selected);
    }
  };
  new ResizeObserver(scheduleDraw).observe(canvas);
  renderPage();
})();
</script></html>`;
}
