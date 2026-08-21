const test = require('node:test');
const assert = require('node:assert/strict');
const plots = require('./plot_utils');

test('extracts a labeled component as a one-dimensional series', () => {
  const dataset = plots.buildDataset({ sample: [0, 1], component: ['A', 'B'], composition: [[.2, .8], [.3, .7]] });
  const composition = dataset.variables.find(variable => variable.name === 'composition');
  const option = plots.axisComponentOptions(composition).find(item => item.label === 'B');
  assert.deepEqual(plots.resolveAxis(composition, option.value).values, [.8, .7]);
});

test('builds a rectangular image plane and filters aligned points', () => {
  const dataset = plots.buildDataset({ x: [1, 2], y: [3, 4], image: [[10, 11], [12, 13]] });
  const image = plots.imagePlane(dataset.variables.find(variable => variable.name === 'image'));
  assert.deepEqual(image.values, [[10, 11], [12, 13]]);
  assert.equal(image.xDimension.coordinateName, 'x');
  assert.equal(image.yDimension.coordinateName, 'y');
  assert.deepEqual(plots.finitePoints([1, 2], [3, null], [5, 6]), [[1, 3, 5]]);
  assert.equal(plots.finitePoints([1], [2, 3], [4]), null);
});

test('recognizes only RGB arrays as image-mode datasets', () => {
  const dataset = plots.buildDataset({ rgb: [[[255, 0, 0], [0, 255, 0]]], scalar: [[1, 2], [3, 4]], rgba: [[[1, 2, 3, 4]]] });
  assert.ok(plots.rgbImage(dataset.variables.find(variable => variable.name === 'rgb')));
  assert.equal(plots.rgbImage(dataset.variables.find(variable => variable.name === 'scalar')), null);
  assert.equal(plots.rgbImage(dataset.variables.find(variable => variable.name === 'rgba')), null);
});

test('summarizes dataset structure without including attributes', () => {
  const summary = plots.structureSummary({
    data_vars: { signal: { dims: ['sample', 'component'], shape: [2, 3], dtype: 'float64', attrs: { units: 'ignored' } } },
    coords: { component: { dims: ['component'], shape: [3], dtype: '<U8', attrs: { note: 'ignored' } } }
  });
  assert.match(summary, /signal \(sample, component\)  shape: \(2, 3\)  dtype: float64/);
  assert.match(summary, /component \(component\)  shape: \(3\)  dtype: <U8/);
  assert.doesNotMatch(summary, /ignored|units|note/);
});

test('summarizes Tiled container arrays and separates coordinates', () => {
  const summary = plots.structureSummary({ variables: {
    img_rgb: { dims: ['height', 'width', 'rgb_channel'], shape: [350, 300, 3], data_type: { kind: 'u', itemsize: 1 } },
    rgb_channel: { role: 'coordinate', dims: ['rgb_channel'], shape: [3], data_type: { kind: 'U', itemsize: 4 } }
  } });
  assert.match(summary, /img_rgb \(height, width, rgb_channel\)  shape: \(350, 300, 3\)  dtype: uint8/);
  assert.match(summary, /Components \/ coordinates:[\s\S]*rgb_channel \(rgb_channel\)  shape: \(3\)  dtype: unicode32/);
});

test('builds plottable variables from a Tiled xarray container payload', () => {
  const dataset = plots.buildDataset({ data: {
    img_rgb: [[[1, 2, 3], [4, 5, 6]]], mask: [[true, false]], avg_rgb: [10, 20, 30]
  }, structures: {
    img_rgb: { dims: ['height', 'width', 'rgb_channel'], shape: [1, 2, 3], data_type: { kind: 'u', itemsize: 1 } },
    mask: { dims: ['height', 'width'], shape: [1, 2], data_type: { kind: 'b', itemsize: 1 } },
    avg_rgb: { dims: ['channel'], shape: [3], data_type: { kind: 'f', itemsize: 8 } }
  } }, { structure: { variables: {
    img_rgb: { dims: ['height', 'width', 'rgb_channel'], shape: [1, 2, 3] },
    mask: { dims: ['height', 'width'], shape: [1, 2] }, avg_rgb: { dims: ['channel'], shape: [3] }
  } } });
  assert.deepEqual(dataset.variables.map(variable => variable.name), ['img_rgb', 'mask', 'avg_rgb']);
  assert.ok(plots.rgbImage(dataset.variables.find(variable => variable.name === 'img_rgb')));
});

test('recommends plots and slices leading dimensions deterministically', () => {
  const dataset = plots.buildDataset({ time: [0, 1], y: [10, 20], x: [1, 2], image: [[[1, 2], [3, 4]], [[5, 6], [7, 8]]] });
  const image = dataset.variables.find(variable => variable.name === 'image');
  assert.equal(plots.recommendPlot(image).mode, 'image');
  assert.deepEqual(plots.sliceToRank(image, 2, { time: 1 }).values, [[5, 6], [7, 8]]);
  assert.equal(plots.downsample([1, 2, 3, 4, 5], 2).reduced, true);
});

test('reshapes flat container arrays using their Tiled structure and labels components', () => {
  const metadata = { data: { attributes: { structure: { variables: { composition_grid: { shape: [2, 4], dims: ['grid', 'component'] } } } } } };
  const dataset = plots.buildDataset({ component: ['Red', 'Blue', 'Green', 'Yellow'], composition_grid: [0, 0, 0, 1, .2, .3, .4, .1] }, metadata);
  const grid = dataset.variables.find(variable => variable.name === 'composition_grid');
  assert.deepEqual(grid.values, [[0, 0, 0, 1], [.2, .3, .4, .1]]);
  assert.deepEqual(plots.axisComponentOptions(grid).map(option => option.label), ['Red', 'Blue', 'Green', 'Yellow']);
  assert.equal(plots.recommendPlot(grid).mode, 'composition');
});

test('keeps 1D variables free of component choices and downsamples aligned axes together', () => {
  const dataset = plots.buildDataset({ energy: [1, 2, 3, 4] });
  const energy = dataset.variables.find(variable => variable.name === 'energy');
  assert.deepEqual(plots.axisComponentOptions(energy), [{ value: 'all', label: 'energy' }]);
  const sampled = plots.downsampleAligned([[0, 1, 2, 3, 4], [0, 10, 20, 30, 40]], 2);
  assert.deepEqual(sampled.values, [[0, 3], [0, 30]]);
  assert.equal(sampled.reduced, true);
});
