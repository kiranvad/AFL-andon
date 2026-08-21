(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TiledPlotUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const isScalar = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  const isPrimitiveArray = value => Array.isArray(value) && value.every(item => !Array.isArray(item));

  function arrayShape(value) {
    if (!Array.isArray(value)) return [];
    if (!value.length) return [0];
    const child = arrayShape(value[0]);
    return value.every(item => JSON.stringify(arrayShape(item)) === JSON.stringify(child)) ? [value.length, ...child] : [];
  }

  function isNumericArray(value) {
    if (!Array.isArray(value) || !value.length) return false;
    const leaves = [];
    const visit = item => Array.isArray(item) ? item.forEach(visit) : leaves.push(item);
    visit(value);
    return leaves.some(isScalar) && leaves.every(item => item === null || item === undefined || item === '' || isScalar(item));
  }

  function structureFor(metadata, name) {
    const structure = metadata?.data?.attributes?.structure || metadata?.attributes?.structure || metadata?.structure || {};
    for (const container of [structure.data_vars, structure.variables, structure.coords, structure.coordinates, structure]) {
      const item = container?.[name];
      if (item && typeof item === 'object') return item;
    }
    return {};
  }

  function reshapeFlat(values, shape) {
    if (!Array.isArray(values) || !Array.isArray(shape) || shape.length < 2 || values.length !== shape.reduce((total, size) => total * size, 1)) return values;
    let offset = 0;
    const build = depth => {
      const size = shape[depth];
      if (depth === shape.length - 1) { const row = values.slice(offset, offset + size); offset += size; return row; }
      return Array.from({ length: size }, () => build(depth + 1));
    };
    return build(0);
  }

  function coordinateCandidates(data, size, excludedName) {
    return Object.entries(data || {}).filter(([name, values]) => name !== excludedName && isPrimitiveArray(values) && values.length === size);
  }

  function metadataCoordinateCandidates(metadata, size) {
    const values = metadata?.data?.attributes?.metadata || metadata?.attributes?.metadata || metadata?.metadata || {};
    return Object.entries(values).filter(([, candidate]) => isPrimitiveArray(candidate) && candidate.length === size);
  }

  function preferredCoordinate(candidates, dimensionName, fallback, dimensionIndex) {
    const exact = candidates.find(([name]) => name === dimensionName);
    if (exact) return exact;
    const positional = dimensionIndex === 0
      ? candidates.find(([name]) => /^(sample|y|row|time|index)$/i.test(name))
      : candidates.find(([name]) => /^(component|x|column|q|Q|index)$/i.test(name));
    if (positional) return positional;
    const familiar = candidates.find(([name]) => /^(x|y|z|q|Q|index|sample|component|time)$/i.test(name));
    return familiar || candidates[0] || fallback;
  }

  function buildDataset(data, metadata) {
    const source = data?.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : (data || {});
    const variables = Object.entries(source).filter(([, values]) => Array.isArray(values)).map(([name, rawValues]) => {
      const structure = structureFor(metadata, name);
      const values = reshapeFlat(rawValues, structure.shape);
      const shape = arrayShape(values);
      const configuredDims = structure.dims || structure.dimensions || [];
      const usedCoordinates = new Set();
      const dims = shape.map((size, index) => {
        const candidates = [...coordinateCandidates(source, size, name), ...metadataCoordinateCandidates(metadata, size)]
          .filter(([candidateName]) => !usedCoordinates.has(candidateName));
        const configuredName = configuredDims[index];
        const coordinate = shape.length === 1 && !configuredName ? null : preferredCoordinate(candidates, configuredName, null, index);
        if (coordinate) usedCoordinates.add(coordinate[0]);
        return {
          name: configuredName || coordinate?.[0] || (shape.length === 1 ? name : `dimension ${index + 1}`),
          size,
          coordinateName: coordinate?.[0] || null,
          coordinateValues: coordinate?.[1] || Array.from({ length: size }, (_, itemIndex) => itemIndex)
        };
      });
      return { name, values, shape, dims, numeric: isNumericArray(values), structure };
    });
    return { source, metadata, variables };
  }

  function axisComponentOptions(variable) {
    if (!variable) return [];
    if (variable.shape.length === 1) return [{ value: 'all', label: variable.dims[0]?.name || 'all values' }];
    if (variable.shape.length !== 2) return [];
    const namedComponent = variable.dims.findIndex(dimension => /component|comp|species|element/i.test(dimension.name));
    const labeledComponent = variable.dims.findIndex(dimension => dimension.coordinateName && dimension.coordinateValues?.some(value => typeof value === 'string'));
    const fixedDimension = namedComponent >= 0 ? namedComponent : labeledComponent >= 0 ? labeledComponent : variable.dims.length - 1;
    const dimension = variable.dims[fixedDimension];
    if (dimension.size > 100) return [{ value: 'matrix', label: '2D matrix (too many components)' }];
    return Array.from({ length: dimension.size }, (_, index) => ({
      value: `${fixedDimension}:${index}`,
      label: String(dimension.coordinateValues?.[index] ?? `${dimension.name} ${index + 1}`)
    }));
  }

  function resolveAxis(variable, component) {
    if (!variable) return null;
    if (variable.shape.length === 1 && component === 'all') {
      return { values: variable.values, label: variable.name, dimension: variable.dims[0]?.name || 'index' };
    }
    const match = /^(\d+):(\d+)$/.exec(component || '');
    if (!match || variable.shape.length !== 2) return null;
    const fixedDimension = Number(match[1]);
    const fixedIndex = Number(match[2]);
    const values = fixedDimension === 0
      ? variable.values[fixedIndex]
      : variable.values.map(row => row[fixedIndex]);
    const fixed = variable.dims[fixedDimension];
    const varying = variable.dims[fixedDimension === 0 ? 1 : 0];
    return {
      values,
      label: `${variable.name} (${fixed.name}=${fixed.coordinateValues[fixedIndex]})`,
      dimension: varying.name
    };
  }

  function imagePlane(variable) {
    if (!variable || !variable.numeric || variable.shape.length !== 2 || !variable.shape.every(size => size > 0)) return null;
    return { values: variable.values, xDimension: variable.dims[1], yDimension: variable.dims[0], label: variable.name };
  }

  function rgbImage(variable) {
    if (!variable || !variable.numeric || variable.shape.length !== 3 || variable.shape[0] <= 0 || variable.shape[1] <= 0 || variable.shape[2] !== 3) return null;
    return { values: variable.values, label: variable.name };
  }

  function finitePoints(x, y, z) {
    if (!x || !y || !z || x.length !== y.length || x.length !== z.length) return null;
    const points = [];
    for (let index = 0; index < x.length; index += 1) {
      if (!isScalar(x[index]) || !isScalar(y[index]) || !isScalar(z[index])) continue;
      const xv = Number(x[index]); const yv = Number(y[index]); const zv = Number(z[index]);
      if (Number.isFinite(xv) && Number.isFinite(yv) && Number.isFinite(zv)) points.push([xv, yv, zv]);
    }
    return points;
  }

  function preferredVariable(variables, excluded = []) {
    const eligible = variables.filter(variable => variable.numeric && variable.shape.length === 1 && !excluded.includes(variable.name));
    return eligible.find(variable => ['q', 'Q', 'x', 'index'].includes(variable.name)) || eligible[0] || null;
  }

  function structureSummary(structure) {
    const root = structure && typeof structure === 'object' ? structure : {};
    const variables = root.data_vars || root.variables || {};
    const coordinates = root.coords || root.coordinates || root.components || {};
    for (const [name, details] of Object.entries(variables)) {
      if (details?.role === 'coordinate') { coordinates[name] = details; delete variables[name]; }
    }
    const sections = [['Data variables', variables], ['Components / coordinates', coordinates]];
    const lines = [];
    const shown = new Set();
    for (const [title, entries] of sections) {
      if (!entries || typeof entries !== 'object') continue;
      const rows = Object.entries(entries).filter(([, value]) => value && typeof value === 'object');
      if (!rows.length) continue;
      lines.push(`${title}:`);
      for (const [name, details] of rows) {
        if (shown.has(name)) continue;
        shown.add(name);
        const dims = details.dims || details.dimensions || [];
        const shape = details.shape || [];
        const rawDtype = details.dtype || details.data_type || details.type;
        const dtype = typeof rawDtype === 'object' && rawDtype ? ({ f: 'float', i: 'int', u: 'uint', b: 'bool', U: 'unicode' }[rawDtype.kind] || rawDtype.kind || 'unknown') + (rawDtype.kind === 'b' ? '' : rawDtype.itemsize ? rawDtype.itemsize * 8 : '') : rawDtype || 'unknown';
        lines.push(`  ${name} (${Array.isArray(dims) ? dims.join(', ') : dims || 'scalar'})  shape: (${Array.isArray(shape) ? shape.join(', ') : shape || 'unknown'})  dtype: ${dtype}`);
      }
    }
    return lines.length ? lines.join('\n') : 'No variable structure is available for this dataset.';
  }

  function recommendPlot(variable) {
    if (!variable?.numeric) return { mode: 'line', reason: 'Choose a numeric variable.' };
    if (variable.shape.length === 2 && variable.dims.some(dimension => /component|comp/i.test(dimension.name)) && variable.dims.find(dimension => /component|comp/i.test(dimension.name))?.size >= 3) return { mode: 'composition', reason: 'Component grid detected.' };
    if (variable.shape.length === 1) return { mode: 'line', reason: 'One-dimensional numeric variable.' };
    if (variable.shape.length >= 2) return { mode: 'image', reason: variable.shape.length === 2 ? 'Rectangular two-dimensional variable.' : 'Multidimensional variable with leading dimensions sliced.' };
    return { mode: 'line', reason: 'Fallback.' };
  }

  function sliceToRank(variable, rank, sliceIndexes = {}) {
    if (!variable) return null;
    let values = variable.values;
    const dims = [...variable.dims];
    while (Array.isArray(values) && dims.length > rank) {
      const dimension = dims.shift();
      const index = Math.max(0, Math.min(dimension.size - 1, Number(sliceIndexes[dimension.name]) || 0));
      values = values[index];
    }
    return { values, dims };
  }

  function downsample(values, maximum) {
    if (!Array.isArray(values) || values.length <= maximum) return { values, reduced: false };
    const stride = Math.ceil(values.length / maximum);
    return { values: values.filter((_, index) => index % stride === 0), reduced: true };
  }

  // Sample aligned series with one shared stride. This preserves the pairwise
  // relationship required by line and 2D scatter plots.
  function downsampleAligned(series, maximum) {
    if (!Array.isArray(series) || !series.length || !series.every(Array.isArray)) return { values: series, reduced: false };
    const length = series[0].length;
    if (!series.every(values => values.length === length)) return null;
    if (length <= maximum) return { values: series, reduced: false };
    const stride = Math.ceil(length / maximum);
    return {
      values: series.map(values => values.filter((_, index) => index % stride === 0)),
      reduced: true
    };
  }

  return { arrayShape, isNumericArray, buildDataset, axisComponentOptions, resolveAxis, imagePlane, rgbImage, finitePoints, preferredVariable, structureSummary, recommendPlot, sliceToRank, downsample, downsampleAligned, reshapeFlat };
});
