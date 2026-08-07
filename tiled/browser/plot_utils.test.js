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
