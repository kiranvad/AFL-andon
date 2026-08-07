(() => {
  const query = new URLSearchParams(location.search);
  const serverName = query.get('server') || 'tiled';
  let entryIds = [];
  try { entryIds = JSON.parse(query.get('plotEntries') || '[]'); } catch (_) { entryIds = []; }
  const state = { datasets: [], slices: {}, mode: 'auto' };
  const $ = id => document.getElementById(id);
  const plotVariable = () => activeDataset()?.variables.find(item => item.name === ($('plot-mode').value === 'scatter3d' ? $('axis-z').value : $('axis-color').value));
  const activeDataset = () => state.datasets[Number($('dataset-select').value) || 0];
  const showError = message => { $('plot-error').textContent = message || ''; $('plot-error').hidden = !message; };

  function options(select, values, selected) {
    select.replaceChildren();
    values.forEach(({ value, label }) => { const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option); });
    if (values.some(item => item.value === selected)) select.value = selected;
  }

  function renderExplorer() {
    renderControls();
  }

  function renderControls() {
    const dataset = activeDataset(); if (!dataset) return;
    const series = dataset.variables.filter(item => item.numeric && item.shape.length <= 2);
    const preferred = window.TiledPlotUtils.preferredVariable(series);
    const defaultZ = series.find(item => item.shape.length === 2) || series[0];
    const componentSeries = series.find(item => window.TiledPlotUtils.axisComponentOptions(item).length >= 3);
    for (const axis of ['x', 'y', 'z', 'color']) {
      const defaultVariable = componentSeries?.name || (axis === 'x' ? preferred?.name : defaultZ?.name);
      options($(`axis-${axis}`), series.map(item => ({ value: item.name, label: item.name })), $(`axis-${axis}`).value || defaultVariable);
      const axisVariable = dataset.variables.find(item => item.name === $(`axis-${axis}`).value);
      const components = window.TiledPlotUtils.axisComponentOptions(axisVariable);
      const componentSelect = $(`axis-${axis}-component`);
      const initialComponent = components[['x', 'y', 'z', 'color'].indexOf(axis)]?.value || components[0]?.value;
      options(componentSelect, components.length ? components : [{ value: '', label: 'Not applicable' }], componentSelect.value || initialComponent);
      componentSelect.disabled = !axisVariable || axisVariable.shape.length <= 1;
    }
    const is3d = $('plot-mode').value === 'scatter3d';
    const isLine = $('plot-mode').value === 'line';
    $('z-axis-control').hidden = !is3d;
    $('color-axis-control').hidden = isLine || (is3d && !$('color-enabled').checked);
    $('color-toggle-control').hidden = !is3d;
    const selected = plotVariable(); if (!selected) return;
    const rank = ['heatmap', 'image', 'contour'].includes($('plot-mode').value) ? 2 : 1;
    const retained = selected.dims.slice(-Math.min(rank, selected.dims.length)).map(dim => dim.name);
    const sliceContainer = $('slice-controls'); sliceContainer.replaceChildren();
    selected.dims.filter(dim => !retained.includes(dim.name)).forEach(dim => {
      const label = document.createElement('label'); label.className = 'slice-control'; label.textContent = `Slice ${dim.name}`;
      const input = document.createElement('input'); input.type = 'range'; input.min = '0'; input.max = String(Math.max(0, dim.size - 1)); input.value = String(state.slices[dim.name] || 0);
      const value = document.createElement('span'); const update = () => { state.slices[dim.name] = Number(input.value); value.textContent = dim.coordinateValues?.[Number(input.value)] ?? input.value; draw(); };
      input.addEventListener('input', update); update(); label.append(input, value); sliceContainer.append(label);
    });
  }

  function valuesForAxis(axis) {
    const item = activeDataset()?.variables.find(entry => entry.name === $(`axis-${axis}`).value);
    const resolved = window.TiledPlotUtils.resolveAxis(item, $(`axis-${axis}-component`).value);
    return resolved?.values || window.TiledPlotUtils.sliceToRank(item, 1, state.slices)?.values || [];
  }
  function axisLabel(axis) {
    const component = $(`axis-${axis}-component`);
    return component.disabled ? $(`axis-${axis}`).value : component.selectedOptions[0]?.textContent || $(`axis-${axis}`).value;
  }
  function linePlot() {
    const x = valuesForAxis('x'); const y = valuesForAxis('y'); if (x.length !== y.length) throw new Error('Line plotting requires X and Y series of the same length.');
    const compact = window.TiledPlotUtils.downsampleAligned([x, y], 50000);
    window.Plotly.react('plot-widget', [{ type: 'scattergl', mode: 'lines+markers', x: compact.values[0], y: compact.values[1], name: axisLabel('y') }], { margin: { t: 35, b: 50, l: 60, r: 20 }, xaxis: { title: axisLabel('x') }, yaxis: { title: axisLabel('y') } }, { responsive: true, displayModeBar: true });
    return compact.reduced;
  }
  function surfacePlot(kind) {
    const selected = window.TiledPlotUtils.sliceToRank(plotVariable(), 2, state.slices); if (!selected || !Array.isArray(selected.values?.[0])) throw new Error(`${kind} requires a rectangular 2D color/value variable.`);
    const [yDim, xDim] = selected.dims;
    const selectedX = valuesForAxis('x'); const selectedY = valuesForAxis('y');
    const xUsesSelection = selectedX.length === xDim?.size; const yUsesSelection = selectedY.length === yDim?.size;
    const trace = { type: kind === 'contour' ? 'contour' : 'heatmap', z: selected.values, x: xUsesSelection ? selectedX : xDim?.coordinateValues, y: yUsesSelection ? selectedY : yDim?.coordinateValues, colorscale: 'Viridis', colorbar: { title: axisLabel('color') }, zsmooth: kind === 'image' ? false : undefined };
    if (kind === 'contour') trace.contours = { coloring: 'fill' };
    if (kind === 'image') trace.hovertemplate = 'x=%{x}<br>y=%{y}<br>value=%{z}<extra></extra>';
    window.Plotly.react('plot-widget', [trace], { margin: { t: 35, b: 50, l: 60, r: 20 }, xaxis: { title: xUsesSelection ? axisLabel('x') : xDim?.name || 'x' }, yaxis: { title: yUsesSelection ? axisLabel('y') : yDim?.name || 'y' } }, { responsive: true, displayModeBar: true }); return false;
  }
  function triContourPlot() {
    const x = valuesForAxis('x'); const y = valuesForAxis('y'); const color = valuesForAxis('color');
    const points = window.TiledPlotUtils.finitePoints(x, y, color);
    if (!points?.length) throw new Error('Triangulated Contourf requires matching one-dimensional X, Y, and color/value series.');
    const compact = window.TiledPlotUtils.downsample(points, 50000); const values = compact.values;
    // Plotly uses a Delaunay triangulation when a mesh has no explicit faces
    // and alphahull is -1. Keeping z=0 makes this a top-down tricontour view.
    window.Plotly.react('plot-widget', [{ type: 'mesh3d', x: values.map(point => point[0]), y: values.map(point => point[1]), z: values.map(() => 0), intensity: values.map(point => point[2]), colorscale: 'Viridis', alphahull: -1, flatshading: false, showscale: true, colorbar: { title: axisLabel('color') }, hovertemplate: `x=%{x}<br>y=%{y}<br>${axisLabel('color')}=%{intensity}<extra></extra>` }], { margin: { t: 25, b: 15, l: 15, r: 15 }, scene: { camera: { projection: { type: 'orthographic' }, eye: { x: 0, y: 0, z: 2.5 } }, xaxis: { title: axisLabel('x') }, yaxis: { title: axisLabel('y') }, zaxis: { visible: false } } }, { responsive: true, displayModeBar: true });
    return compact.reduced;
  }
  function pointPlot() {
    const x = valuesForAxis('x'); const y = valuesForAxis('y'); const z = valuesForAxis('z');
    const color = $('color-enabled').checked ? valuesForAxis('color') : null;
    if (color && color.length !== x.length) throw new Error('3D point color requires a series with the same length as X, Y, and Z.');
    if (x.length !== y.length || x.length !== z.length) throw new Error('Point plotting requires compatible numeric X, Y, and Z series.');
    const points = [];
    x.forEach((xValue, index) => {
      if (!Number.isFinite(Number(xValue)) || !Number.isFinite(Number(y[index])) || !Number.isFinite(Number(z[index])) || (color && !Number.isFinite(Number(color[index])))) return;
      points.push(color ? [Number(xValue), Number(y[index]), Number(z[index]), Number(color[index])] : [Number(xValue), Number(y[index]), Number(z[index])]);
    });
    if (!points.length) throw new Error('Point plotting requires compatible numeric X, Y, and Z series.');
    const compact = window.TiledPlotUtils.downsample(points, 50000); const values = compact.values;
    const labels = { x: axisLabel('x'), y: axisLabel('y'), z: axisLabel('z') };
    const trace = { type: 'scatter3d', mode: 'markers', x: values.map(p => p[0]), y: values.map(p => p[1]), z: values.map(p => p[2]), marker: color ? { size: 4, color: values.map(p => p[3]), colorscale: 'Viridis', showscale: true, colorbar: { title: axisLabel('color') } } : { size: 4 } };
    const layout = { margin: { t: 35, b: 10, l: 10, r: 10 }, scene: { xaxis: { title: labels.x }, yaxis: { title: labels.y }, zaxis: { title: labels.z } } };
    window.Plotly.react('plot-widget', [trace], layout, { responsive: true, displayModeBar: true }); return compact.reduced;
  }
  function scatter2dPlot() {
    const x = valuesForAxis('x'); const y = valuesForAxis('y'); if (x.length !== y.length) throw new Error('Scatter 2D requires X and Y series of the same length.');
    const compact = window.TiledPlotUtils.downsampleAligned([x, y], 50000);
    const color = valuesForAxis('color');
    if (color.length && color.length !== x.length) throw new Error('Scatter 2D color requires a series with the same length as X and Y.');
    const compactColor = color.length ? window.TiledPlotUtils.downsampleAligned([x, color], 50000)?.values[1] : null;
    window.Plotly.react('plot-widget', [{ type: 'scattergl', mode: 'markers', x: compact.values[0], y: compact.values[1], marker: compactColor ? { color: compactColor, colorscale: 'Viridis', showscale: true, colorbar: { title: axisLabel('color') } } : undefined }], { margin: { t: 35, b: 50, l: 60, r: 20 }, xaxis: { title: axisLabel('x') }, yaxis: { title: axisLabel('y') } }, { responsive: true, displayModeBar: true }); return compact.reduced;
  }
  function draw() {
    const selected = plotVariable(); if (!selected) return;
    const mode = $('plot-mode').value; $('recommendation').textContent = ''; showError();
    try {
      const reduced = mode === 'scatter3d' ? pointPlot() : mode === 'scatter2d' ? scatter2dPlot() : mode === 'contour' && selected.shape.length === 1 ? triContourPlot() : ['contour', 'heatmap', 'image'].includes(mode) ? surfacePlot(mode) : linePlot();
      $('downsample-note').hidden = !reduced; $('downsample-note').textContent = reduced ? 'Large series was uniformly downsampled to 50,000 points.' : '';
    } catch (error) { window.Plotly.purge('plot-widget'); $('downsample-note').hidden = true; showError(error.message); }
  }

  async function load() {
    if (!entryIds.length) return showError('No Tiled entries were provided.');
    try {
      const results = await Promise.all(entryIds.map(async id => {
        const metadata = await window.tiledBrowser.metadata(serverName, id);
        if (!metadata.success) throw new Error(`${id}: ${metadata.error}`);
        const isContainer = metadata.data?.data?.attributes?.structure_family === 'container';
        const data = isContainer ? await window.tiledBrowser.containerData(serverName, id) : await window.tiledBrowser.fullData(serverName, id);
        if (!data.success) throw new Error(`${id}: ${data.error}`);
        const normalizedMetadata = isContainer ? {
          ...metadata.data,
          data: {
            ...metadata.data.data,
            attributes: {
              ...metadata.data.data?.attributes,
              structure: { variables: data.data.structures }
            }
          }
        } : metadata.data;
        return { id, metadata: normalizedMetadata, ...window.TiledPlotUtils.buildDataset(data.data, normalizedMetadata) };
      }));
      state.datasets = results.filter(dataset => dataset.variables.some(item => item.numeric));
      if (!state.datasets.length) throw new Error('The selected entries contain no numeric arrays.');
      options($('dataset-select'), state.datasets.map((dataset, index) => ({ value: index, label: dataset.id })), '0'); $('plot-status').textContent = `${state.datasets.length} selected dataset${state.datasets.length === 1 ? '' : 's'} loaded`;
      renderExplorer(); draw();
    } catch (error) { showError(error.message || 'Unable to load Tiled data.'); }
  }
  document.addEventListener('DOMContentLoaded', () => {
    $('dataset-select').addEventListener('change', () => { state.slices = {}; renderExplorer(); draw(); });
    ['plot-mode', 'color-enabled', 'axis-x', 'axis-y', 'axis-z', 'axis-color', 'axis-x-component', 'axis-y-component', 'axis-z-component', 'axis-color-component'].forEach(id => $(id).addEventListener('change', () => { renderControls(); draw(); }));
    $('close-window').addEventListener('click', () => window.close()); load();
  });
})();
