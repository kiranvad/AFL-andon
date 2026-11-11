const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const plots = require('./plot_utils');

const html = fs.readFileSync(path.join(__dirname, 'plot.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, 'plot_window.js'), 'utf8');

// A small DOM adapter exercises the actual window controller and its events
// without opening Electron or requiring a running Tiled server.
class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = new Map();
    this.textContent = '';
    this.hidden = false;
    this.checked = false;
    this.selected = false;
    this._value = '';
  }
  get value() { return this.tag === 'select' ? this.selectedOptions[0]?.value || '' : this._value; }
  set value(value) {
    this._value = String(value);
    if (this.tag === 'select') this.children.forEach(option => { option.selected = option.value === this._value; });
  }
  get selectedOptions() { return this.children.filter(option => option.selected); }
  replaceChildren() { this.children = []; }
  append(...children) {
    children.forEach(child => {
      if (this.tag === 'select' && !this.children.length) child.selected = true;
      this.children.push(child);
    });
  }
  addEventListener(event, callback) { this.listeners.set(event, callback); }
  dispatch(event = 'change') { this.listeners.get(event)?.(); }
}

async function viewer(entries) {
  const elements = new Map([...html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)].map(([, tag, id]) => [id, new Element(tag)]));
  for (const [, id, body] of html.matchAll(/<select id="([^"]+)"[^>]*>(.*?)<\/select>/g)) {
    for (const [, value, label] of body.matchAll(/<option value="([^"]+)">(.*?)<\/option>/g)) {
      const option = new Element('option'); option.value = value; option.textContent = label; elements.get(id).append(option);
    }
  }
  let ready; let rendered; let purges = 0;
  const requests = [];
  const read = async (kind, server, id) => {
    requests.push({ kind, server, id });
    const entry = entries.find(item => item.id === id);
    const metadata = { data: { attributes: {
      metadata: { task_name: 'measure', sample_name: entry.sample },
      structure_family: entry.container ? 'container' : 'array',
      structure: { variables: entry.structures || {} }
    } } };
    return { success: true, data: kind === 'metadata' ? metadata : entry.container ? { data: entry.data, structures: entry.structures } : entry.data };
  };
  vm.runInNewContext(source, {
    URLSearchParams,
    location: { search: `?server=test-tiled&plotEntries=${encodeURIComponent(JSON.stringify(entries.map(entry => entry.id)))}` },
    document: {
      getElementById: id => { assert.ok(elements.has(id), `Missing plot element ${id}`); return elements.get(id); },
      createElement: tag => new Element(tag),
      addEventListener: (event, callback) => { if (event === 'DOMContentLoaded') ready = callback; }
    },
    window: {
      TiledPlotUtils: plots,
      tiledBrowser: {
        metadata: (server, id) => read('metadata', server, id),
        fullData: (server, id) => read('fullData', server, id),
        containerData: (server, id) => read('containerData', server, id)
      },
      Plotly: {
        react: (id, traces, layout) => { rendered = JSON.parse(JSON.stringify({ id, traces, layout })); },
        purge: () => { rendered = null; purges += 1; }
      },
      close() {}
    }
  }, { filename: 'plot_window.js' });
  ready();
  await new Promise(resolve => setImmediate(resolve));
  return {
    element: id => elements.get(id),
    change: (id, value) => { const element = elements.get(id); if (typeof value === 'boolean') element.checked = value; else element.value = value; element.dispatch(); },
    rendered: () => rendered,
    purges: () => purges,
    requests
  };
}

const spectra = () => [
  { id: 'entry-a', sample: 'Sample A', data: { q: [1, 2, 3], intensity: [10, 20, 30] } },
  { id: 'entry-b', sample: 'Sample B', data: { q: [1.5, 2.5], intensity: [15, 25] } }
];

test('automatically overlays same-task spectra using each entry’s coordinates and lengths', async () => {
  const view = await viewer(spectra());
  const { traces, layout } = view.rendered();
  assert.equal(view.element('plot-mode').value, 'line');
  assert.equal(view.element('overlay-enabled').checked, true);
  assert.equal(view.element('dataset-select-label').textContent, 'Axes from dataset');
  assert.deepEqual(traces.map(trace => trace.x), [[1, 2, 3], [1.5, 2.5]]);
  assert.deepEqual(traces.map(trace => trace.y), [[10, 20, 30], [15, 25]]);
  assert.deepEqual(traces.map(trace => trace.name), ['Sample A (entry-a)', 'Sample B (entry-b)']);
  assert.notEqual(traces[0].line.color, traces[1].line.color);
  assert.equal(layout.xaxis.title, 'q');
  assert.equal(layout.yaxis.title, 'intensity');
  assert.equal(layout.showlegend, true);
  assert.equal(view.element('plot-status').textContent, '2 selected datasets loaded · 2 plotted');
  assert.equal(view.element('recommendation').textContent, '');
  assert.equal(view.purges(), 0);
});

test('overlay can be toggled while individual entries remain selectable', async () => {
  const view = await viewer(spectra());
  view.change('overlay-enabled', false);
  assert.deepEqual(view.rendered().traces.map(trace => trace.uid), ['entry-a']);
  assert.equal(view.element('dataset-select-label').textContent, 'Select dataset');
  view.change('dataset-select', '1');
  assert.deepEqual(view.rendered().traces.map(trace => trace.uid), ['entry-b']);
  view.change('overlay-enabled', true);
  assert.equal(view.rendered().traces.length, 2);
});

test('mixed selections report missing axes and mismatched series without discarding valid traces', async () => {
  const view = await viewer([
    ...spectra(),
    { id: 'missing-intensity', data: { q: [1, 2], voltage: [10, 20] } },
    { id: 'mismatched-lengths', data: { q: [1, 2, 3], intensity: [10, 20] } }
  ]);
  assert.equal(view.rendered().traces.length, 2);
  assert.match(view.element('recommendation').textContent, /Skipped 2 incompatible datasets/);
  assert.match(view.element('recommendation').textContent, /missing-intensity: Missing numeric variable intensity/);
  assert.match(view.element('recommendation').textContent, /mismatched-lengths: X and Y series must have the same length/);
  assert.equal(view.element('plot-error').hidden, true);
  view.change('overlay-enabled', false);
  view.change('dataset-select', '3');
  assert.equal(view.rendered(), null);
  assert.equal(view.element('plot-error').hidden, false);
});

test('2D scatter overlays keep color values aligned and share one color scale', async () => {
  const view = await viewer(spectra());
  view.change('plot-mode', 'scatter2d');
  view.change('axis-color', 'intensity');
  const { traces, layout } = view.rendered();
  assert.equal(traces.length, 2);
  assert.deepEqual(traces.map(trace => trace.marker.color), [[10, 20, 30], [15, 25]]);
  assert.ok(traces.every(trace => trace.marker.coloraxis === 'coloraxis'));
  assert.notEqual(traces[0].marker.symbol, traces[1].marker.symbol);
  assert.equal(layout.coloraxis.colorbar.title, 'intensity');
});

test('3D overlays match reordered labeled components in containers and preserve them when changing reference', async () => {
  const structures = { grid: { dims: ['point', 'component'], shape: [2, 3] } };
  const view = await viewer([
    { id: 'grid-a', container: true, structures, data: { point: [0, 1], component: ['A', 'B', 'C'], grid: [[1, 2, 3], [4, 5, 6]] } },
    { id: 'grid-b', container: true, structures, data: { point: [0, 1], component: ['C', 'A', 'B'], grid: [[30, 10, 20], [60, 40, 50]] } }
  ]);
  view.change('plot-mode', 'scatter3d');
  let traces = view.rendered().traces;
  assert.ok(traces.every(trace => trace.type === 'scatter3d'));
  assert.deepEqual(traces.map(trace => [trace.x, trace.y, trace.z]), [
    [[1, 4], [2, 5], [3, 6]], [[10, 40], [20, 50], [30, 60]]
  ]);
  view.change('dataset-select', '1');
  assert.equal(view.element('plot-mode').value, 'scatter3d');
  assert.deepEqual(view.rendered().traces.map(trace => [trace.x, trace.y, trace.z]), traces.map(trace => [trace.x, trace.y, trace.z]));
  view.change('color-enabled', true);
  traces = view.rendered().traces;
  assert.ok(traces.every(trace => trace.marker.coloraxis === 'coloraxis'));
  assert.notEqual(traces[0].marker.symbol, traces[1].marker.symbol);
  assert.ok(view.requests.filter(request => request.kind === 'containerData').length === 2);
  assert.equal(view.purges(), 0);
});

test('large overlays downsample each dataset with aligned X, Y, and color values', async () => {
  const q = Array.from({ length: 50001 }, (_, index) => index);
  const view = await viewer([
    { id: 'large', data: { q, intensity: q.map(value => value * 10) } },
    ...spectra().slice(1)
  ]);
  view.change('plot-mode', 'scatter2d');
  view.change('axis-color', 'intensity');
  const [large, small] = view.rendered().traces;
  assert.ok(large.x.length <= 50000);
  assert.deepEqual(large.y, large.x.map(value => value * 10));
  assert.deepEqual(large.marker.color, large.y);
  assert.deepEqual(small.x, [1.5, 2.5]);
  assert.equal(view.element('downsample-note').hidden, false);
});

test('single datasets and RGB image browsing retain individual plotting', async () => {
  const single = await viewer(spectra().slice(0, 1));
  assert.equal(single.element('overlay-control').hidden, true);
  assert.equal(single.rendered().traces.length, 1);
  const view = await viewer([
    { id: 'image-a', data: { rgb: [[[255, 0, 0]]] } },
    { id: 'image-b', data: { rgb: [[[0, 255, 0]]] } }
  ]);
  assert.equal(view.element('overlay-enabled').disabled, true);
  assert.equal(view.rendered().traces.length, 1);
  assert.equal(view.rendered().traces[0].type, 'image');
  view.change('dataset-select', '1');
  assert.deepEqual(view.rendered().traces[0].z, [[[0, 255, 0]]]);
  assert.match(view.element('recommendation').textContent, /This plot shows the selected dataset/);
  assert.equal(view.purges(), 0);
});

test('scalar images, heatmaps, and contours continue to render the selected dataset', async () => {
  const view = await viewer([
    { id: 'plane-a', data: { image: [[null, 2], [null, 4]] } },
    { id: 'plane-b', data: { image: [[10, 20], [30, 40]] } }
  ]);
  assert.deepEqual(view.rendered().traces[0].z, [[null, 2], [null, 4]]);
  for (const mode of ['heatmap', 'contour']) {
    view.change('plot-mode', mode);
    assert.equal(view.rendered().traces.length, 1);
    assert.equal(view.rendered().traces[0].type, mode);
    assert.equal(view.element('overlay-enabled').disabled, true);
  }
  assert.equal(view.purges(), 0);
});
