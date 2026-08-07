(() => {
  const PAGE_SIZE = 50;
  const FILTER_FIELDS = ['driver_name', 'sample_name', 'sample_uuid', 'AL_campaign_name', 'AL_uuid'];
  const SEARCH_FIELDS = ['task_name', 'driver_name', 'sample_name', 'sample_uuid', 'AL_campaign_name', 'AL_uuid'];
  const COLUMNS = [
    ['id', 'Entry ID'], ['task_name', 'Task Name'], ['driver_name', 'Driver Name'],
    ['meta_started', 'Started'], ['meta_ended', 'Ended'], ['run_time_minutes', 'Runtime (min)'],
    ['sample_uuid', 'Sample UUID'], ['sample_name', 'Sample Name'], ['AL_campaign_name', 'AL Campaign'],
    ['AL_uuid', 'AL UUID'], ['AL_components', 'AL Components']
  ];
  const serverName = new URLSearchParams(location.search).get('server') || 'tiled';
  const standalonePlotEntries = (() => {
    try {
      const value = JSON.parse(new URLSearchParams(location.search).get('plotEntries') || '[]');
      return Array.isArray(value) ? value.filter(Boolean).map(String) : [];
    } catch (_) { return []; }
  })();
  // Tiled's `-` sort token requests descending catalog creation time. This
  // avoids the mixed legacy/current metadata ended fields.
  const state = { offset: 0, total: 0, rows: [], selected: new Set(), filters: {}, sort: '-', plotData: [], catalogPath: '', distinctValues: {} };
  const $ = id => document.getElementById(id);

  const nested = (obj, path) => path.split('.').reduce((value, key) => value && value[key], obj);
  function metadataFor(item) { return item?.attributes?.metadata || item?.metadata || {}; }
  function value(item, name) {
    const metadata = metadataFor(item);
    const candidates = name.startsWith('meta_')
      ? [`meta.${name.slice(5)}`, `attrs.meta.${name.slice(5)}`]
      : [name, `attrs.${name}`];
    for (const candidate of candidates) {
      const found = nested(metadata, candidate);
      if (found !== undefined && found !== null) return found;
    }
    return '';
  }
  function display(value) { return value === '' || value === null || value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value); }
  function rowFor(item) {
    const row = { id: item.id, _item: item };
    COLUMNS.forEach(([field]) => { row[field] = field === 'id' ? item.id : value(item, field); });
    return row;
  }
  function setStatus(kind, text) { $('connection-status').className = `status-${kind}`; $('connection-status').querySelector('.status-text').textContent = text; }
  function showError(message = '') { $('error-container').hidden = !message; $('error-text').textContent = message; }
  function loading(active) { $('loading-overlay').style.display = active ? 'flex' : 'none'; }
  function currentQueries() { return [...document.querySelectorAll('.query-row')].map(row => ({ field: row.querySelector('.query-field').value, value: row.querySelector('.query-value').value })).filter(query => query.value.trim()); }

  function renderFilters() {
    const container = $('filter-selects'); container.replaceChildren();
    FILTER_FIELDS.forEach(field => {
      const group = document.createElement('div'); group.className = 'filter-group';
      const label = document.createElement('label'); label.htmlFor = `filter-${field}`; label.textContent = field.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
      const box = document.createElement('div'); box.className = 'filter-box';
      const input = document.createElement('input'); input.id = `filter-${field}`; input.placeholder = 'Type a value…'; input.setAttribute('list', `options-${field}`);
      const list = document.createElement('datalist'); list.id = `options-${field}`;
      const add = document.createElement('button'); add.type = 'button'; add.textContent = 'Add';
      const addValue = () => { const next = input.value.trim(); if (!next) return; state.filters[field] = [...new Set([...(state.filters[field] || []), next])]; input.value = ''; renderFilters(); };
      add.addEventListener('click', addValue); input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addValue(); } });
      input.addEventListener('focus', () => loadDistinctValues(field));
      box.append(input, add, list); group.append(label, box);
      const tags = document.createElement('div'); tags.className = 'filter-tags';
      (state.filters[field] || []).forEach(filter => { const tag = document.createElement('span'); tag.className = 'filter-tag'; tag.append(document.createTextNode(filter)); const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${filter}`); remove.addEventListener('click', () => { state.filters[field] = state.filters[field].filter(item => item !== filter); renderFilters(); }); tag.append(remove); tags.append(tag); });
      group.append(tags); container.append(group);
    });
    for (const field of FILTER_FIELDS) {
      const list = $(`options-${field}`);
      [...new Set([...(state.distinctValues[field] || []), ...state.rows.map(row => row[field]).filter(Boolean)])].sort().forEach(optionValue => { const option = document.createElement('option'); option.value = optionValue; list.append(option); });
    }
  }

  async function loadDistinctValues(field) {
    if (state.distinctValues[field]) return;
    try {
      const result = await window.tiledBrowser.distinct(serverName, field, state.filters);
      if (!result.success) throw new Error(result.error);
      const metadata = result.data?.metadata || {};
      const values = [...(metadata[`attrs.${field}`] || []), ...(metadata[field] || [])]
        .map(item => item?.value).filter(value => value !== null && value !== undefined && value !== '');
      state.distinctValues[field] = [...new Set(values)].sort((a, b) => String(a).localeCompare(String(b)));
      const list = $(`options-${field}`);
      if (list) { list.replaceChildren(); state.distinctValues[field].forEach(value => { const option = document.createElement('option'); option.value = value; list.append(option); }); }
    } catch (error) { showError(`Could not load ${field.replaceAll('_', ' ')} filters: ${error.message}`); }
  }

  function addQuery(field = 'sample_name', text = '') {
    const row = document.createElement('div'); row.className = 'query-row';
    const select = document.createElement('select'); select.className = 'query-field';
    SEARCH_FIELDS.forEach(name => { const option = document.createElement('option'); option.value = name; option.textContent = name.replaceAll('_', ' '); option.selected = name === field; select.append(option); });
    const input = document.createElement('input'); input.className = 'query-value'; input.value = text; input.placeholder = 'Contains…';
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-query-btn'; remove.textContent = '×'; remove.addEventListener('click', () => row.remove());
    row.append(select, input, remove); $('query-rows').append(row);
  }

  function tiledFieldPath(field) {
    if (field === 'id') return 'id';
    if (field === 'meta_started') return 'attrs.meta.started';
    if (field === 'meta_ended') return '__recent__';
    if (field === 'run_time_minutes') return 'attrs.meta.run_time_minutes';
    return `attrs.${field}`;
  }

  function renderHeader() {
    const tr = document.createElement('tr'); const select = document.createElement('th'); select.textContent = 'Select'; tr.append(select);
    COLUMNS.forEach(([field, label]) => { const th = document.createElement('th'); const sort = document.createElement('button'); sort.type = 'button'; const key = tiledFieldPath(field); const recent = key === '__recent__'; const prefix = recent && state.sort === '-' ? ' ▼' : !recent && state.sort === key ? ' ▲' : !recent && state.sort === `-${key}` ? ' ▼' : ''; sort.textContent = label + prefix; sort.addEventListener('click', () => { state.sort = recent ? (state.sort === '-' ? '' : '-') : (state.sort === key ? `-${key}` : key); state.offset = 0; load(); }); th.append(sort); tr.append(th); });
    const actions = document.createElement('th'); actions.textContent = 'Actions'; tr.append(actions); $('entries-head').replaceChildren(tr);
  }
  function updateSelectionControls() {
    const count = state.selected.size; $('copy-entry-id-button').disabled = !count; $('copy-sample-uuid-button').disabled = !count; $('plot-selected-btn').disabled = !count;
    $('copy-entry-id-button').textContent = count ? `Copy Entry ID (${count})` : 'Copy Entry ID'; $('copy-sample-uuid-button').textContent = count ? `Copy Sample UUID (${count})` : 'Copy Sample UUID';
  }
  function renderRows() {
    renderHeader(); const body = $('entries'); body.replaceChildren();
    state.rows.forEach(row => {
      const tr = document.createElement('tr'); const selectCell = document.createElement('td'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = state.selected.has(row.id); checkbox.addEventListener('change', () => { checkbox.checked ? state.selected.add(row.id) : state.selected.delete(row.id); updateSelectionControls(); }); selectCell.append(checkbox); tr.append(selectCell);
      COLUMNS.forEach(([field]) => { const cell = document.createElement('td'); if (field === 'id') cell.className = 'entry-id'; cell.textContent = display(row[field]); tr.append(cell); });
      const actionCell = document.createElement('td'); actionCell.className = 'actions';
      const data = createRowAction('Data', `View data for ${row.id}`, () => showData(row.id));
      const metadata = createRowAction('Metadata', `View metadata for ${row.id}`, () => showMetadata(row.id));
      actionCell.append(data, metadata); tr.append(actionCell); body.append(tr);
    });
    $('total-count').textContent = `Total: ${state.total} entries`; const start = state.total ? state.offset + 1 : 0; $('page-summary').textContent = `Showing ${start}–${Math.min(state.offset + state.rows.length, state.total)} of ${state.total}`; $('previous-page').disabled = state.offset === 0; $('next-page').disabled = state.offset + state.rows.length >= state.total; updateSelectionControls();
  }
  async function load() {
    loading(true); showError(); setStatus('loading', 'Loading…');
    try {
      const result = await window.tiledBrowser.search(serverName, { offset: state.offset, limit: PAGE_SIZE, sort: state.sort, queries: currentQueries(), filters: state.filters });
      if (!result.success) throw new Error(result.error);
      const payload = result.data || {}; state.rows = (Array.isArray(payload.data) ? payload.data : []).map(rowFor); state.total = Number(payload.meta?.count ?? payload.total_count ?? state.rows.length); state.catalogPath = payload.andon_catalog_path || '/'; state.selected.clear(); renderFilters(); renderRows(); setStatus('connected', `Connected · ${state.catalogPath}`);
    } catch (error) { state.rows = []; state.total = 0; renderRows(); showError(error.message || 'Tiled request failed.'); setStatus('error', 'Connection Error'); }
    finally { loading(false); }
  }
  function createRowAction(label, ariaLabel, handler) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = label; button.setAttribute('aria-label', ariaLabel);
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await handler(); } finally { button.disabled = false; }
    });
    return button;
  }
  function openLoadingDialog(dialogId, contentId, message) {
    $(contentId).textContent = message;
    const dialog = $(dialogId);
    if (!dialog.open) dialog.showModal();
  }
  async function showMetadata(entryId) {
    openLoadingDialog('metadata-dialog', 'metadata', 'Loading metadata…');
    const result = await window.tiledBrowser.metadata(serverName, entryId);
    if (!result.success) { $('metadata-dialog').close(); return showError(result.error); }
    $('metadata').textContent = JSON.stringify(result.data?.data?.attributes?.metadata ?? result.data, null, 2);
  }
  async function showData(entryId) {
    openLoadingDialog('data-dialog', 'dataset-data', 'Loading dataset summary…');
    const result = await window.tiledBrowser.dataPreview(serverName, entryId);
    if (!result.success) { $('data-dialog').close(); return showError(result.error); }
    $('dataset-data').textContent = JSON.stringify(result.data, null, 2);
  }
  function selectedRows() { return state.rows.filter(row => state.selected.has(row.id)); }
  function openCopy(title, text) { $('copy-title').textContent = title; $('copy-text').value = text; $('copy-dialog').showModal(); }
  async function plotEntries(entryIds) {
    if (!entryIds.length) return; if (!$('plot-dialog').open) $('plot-dialog').showModal(); $('plot-dataset-count').textContent = `Loading ${entryIds.length} selected dataset${entryIds.length === 1 ? '' : 's'}…`; $('plot-error').hidden = true; $('plot-empty').hidden = false; $('plot-dataset').replaceChildren(); state.plotData = [];
    try {
      for (const entryId of entryIds) {
        const [dataResult, metadataResult] = await Promise.all([
          window.tiledBrowser.fullData(serverName, entryId), window.tiledBrowser.metadata(serverName, entryId)
        ]);
        if (!dataResult.success) throw new Error(`${entryId}: ${dataResult.error}`);
        const parsed = window.TiledPlotUtils.buildDataset(dataResult.data, metadataResult.success ? metadataResult.data : null);
        if (parsed.variables.some(variable => variable.numeric)) state.plotData.push({ id: entryId, ...parsed });
      }
      if (!state.plotData.length) throw new Error('None of the selected entries contains plottable numeric array data.');
      state.plotData.forEach((dataset, index) => { const option = document.createElement('option'); option.value = index; option.textContent = dataset.id; $('plot-dataset').append(option); }); $('plot-dataset-count').textContent = `${state.plotData.length} plottable selected dataset${state.plotData.length === 1 ? '' : 's'}`; populatePlotControls(); drawPlot();
    } catch (error) { $('plot-error').textContent = error.message || 'Unable to load selected Tiled data.'; $('plot-error').hidden = false; }
  }
  async function plotSelected() {
    const entryIds = selectedRows().map(row => row.id); if (!entryIds.length) return;
    const result = await window.tiledBrowser.openPlot(serverName, entryIds);
    if (!result.success) showError(result.error || 'Unable to open the Tiled plot window.');
  }
  function activePlotDataset() { return state.plotData[Number($('plot-dataset').value) || 0]; }
  function axisVariableSelect(axis) { return $(`plot-${axis}-variable`); }
  function axisComponentSelect(axis) { return $(`plot-${axis}-component`); }
  function variableByName(dataset, name) { return dataset?.variables.find(variable => variable.name === name); }
  function axisVariables(dataset, axis) { return dataset.variables.filter(variable => variable.shape.length && (axis === 'z' ? variable.numeric : variable.shape.length === 1 || variable.numeric)); }
  function setOptions(select, values, selected) { select.replaceChildren(); values.forEach(value => { const option = document.createElement('option'); option.value = value.value; option.textContent = value.label; select.append(option); }); if (values.some(value => value.value === selected)) select.value = selected; }
  function populateAxisComponent(axis) {
    const dataset = activePlotDataset(); const variable = variableByName(dataset, axisVariableSelect(axis).value);
    const choices = window.TiledPlotUtils.axisComponentOptions(variable);
    setOptions(axisComponentSelect(axis), choices.length ? choices : [{ value: '', label: 'No compatible component' }], choices[0]?.value);
  }
  function coordinateVariable(dataset, dimension) { return variableByName(dataset, dimension?.coordinateName) || variableByName(dataset, dimension?.name); }
  function populatePlotControls() {
    const dataset = activePlotDataset(); if (!dataset) return;
    const imageVariable = dataset.variables.find(variable => window.TiledPlotUtils.imagePlane(variable));
    const xDefault = imageVariable ? coordinateVariable(dataset, imageVariable.dims[1]) : window.TiledPlotUtils.preferredVariable(dataset.variables);
    const yDefault = imageVariable ? coordinateVariable(dataset, imageVariable.dims[0]) : window.TiledPlotUtils.preferredVariable(dataset.variables, [xDefault?.name]);
    const zDefault = imageVariable || window.TiledPlotUtils.preferredVariable(dataset.variables, [xDefault?.name, yDefault?.name]) || yDefault;
    for (const axis of ['x', 'y', 'z']) {
      const selected = axis === 'x' ? xDefault : axis === 'y' ? yDefault : zDefault;
      setOptions(axisVariableSelect(axis), axisVariables(dataset, axis).map(variable => ({ value: variable.name, label: variable.name })), selected?.name);
      populateAxisComponent(axis);
    }
  }
  function resolvePlotAxis(axis) { const dataset = activePlotDataset(); return window.TiledPlotUtils.resolveAxis(variableByName(dataset, axisVariableSelect(axis).value), axisComponentSelect(axis).value); }
  function showPlotError(message) { $('plot-error').textContent = message; $('plot-error').hidden = false; }
  function plotLayout(title, labels, threeDimensional = false) {
    return threeDimensional ? { title, margin: { t: 40, b: 10, l: 10, r: 10 }, scene: { xaxis: { title: labels.x }, yaxis: { title: labels.y }, zaxis: { title: labels.z } } } : { title, margin: { t: 40, b: 55, l: 65, r: 25 }, xaxis: { title: labels.x }, yaxis: { title: labels.y } };
  }
  function renderThreeDimensional(x, y, z) {
    const points = window.TiledPlotUtils.finitePoints(x.values, y.values, z.values);
    if (!points?.length) throw new Error('3D plotting requires X, Y, and Z numeric series of the same length.');
    window.Plotly.react('plot-widget', [{ type: 'scatter3d', mode: 'markers', x: points.map(point => point[0]), y: points.map(point => point[1]), z: points.map(point => point[2]), marker: { size: 4, color: '#1677ad' } }], plotLayout('3D plot', { x: x.label, y: y.label, z: z.label }, true), { responsive: true, displayModeBar: true });
  }
  function renderColorPlot(x, y, z) {
    const points = window.TiledPlotUtils.finitePoints(x.values, y.values, z.values);
    if (!points?.length) throw new Error('Color mode requires X, Y, and Z numeric series of the same length.');
    window.Plotly.react('plot-widget', [{ type: 'scatter', mode: 'markers', x: points.map(point => point[0]), y: points.map(point => point[1]), marker: { size: 7, color: points.map(point => point[2]), colorscale: 'Viridis', showscale: true, colorbar: { title: z.label } } }], plotLayout('2D plot colored by Z', { x: x.label, y: y.label }), { responsive: true, displayModeBar: true });
  }
  function renderImagePlot(x, y, zVariable) {
    const image = window.TiledPlotUtils.imagePlane(zVariable);
    if (!image) throw new Error('Image mode requires a rectangular 2D numeric Z variable.');
    if (!x || !y || x.values.length !== image.xDimension.size || y.values.length !== image.yDimension.size) throw new Error('Image mode requires X and Y coordinates matching the image columns and rows.');
    window.Plotly.react('plot-widget', [{ type: 'heatmap', z: image.values, x: x.values, y: y.values, colorscale: 'Viridis', colorbar: { title: image.label }, hovertemplate: 'x=%{x}<br>y=%{y}<br>z=%{z}<extra></extra>' }], plotLayout(image.label, { x: x.label, y: y.label }), { responsive: true, displayModeBar: true });
  }
  function drawPlot() {
    const dataset = activePlotDataset(); if (!dataset || !window.Plotly) return;
    $('plot-error').hidden = true; const x = resolvePlotAxis('x'); const y = resolvePlotAxis('y'); const z = resolvePlotAxis('z'); const zVariable = variableByName(dataset, axisVariableSelect('z').value); const selectedMode = $('plot-mode').value; const color = $('plot-z-color').checked;
    try {
      if (color) {
        try { renderColorPlot(x, y, z); }
        catch (error) { $('plot-z-color').checked = false; showPlotError(`${error.message} Color was disabled; attempting 3D.`); renderThreeDimensional(x, y, z); }
      } else if (selectedMode === 'image' || (selectedMode === 'auto' && window.TiledPlotUtils.imagePlane(zVariable))) renderImagePlot(x, y, zVariable);
      else renderThreeDimensional(x, y, z);
      $('plot-empty').hidden = true;
    } catch (error) { window.Plotly.purge('plot-widget'); showPlotError(error.message || 'Unable to render the selected plot.'); $('plot-empty').hidden = false; }
  }
  function clearAll() { state.filters = {}; $('query-rows').replaceChildren(); addQuery(); state.offset = 0; load(); }
  function closePlot() { $('plot-dialog').close(); if (standalonePlotEntries.length) window.close(); }
  function setup() {
    $('apply-filters-button').addEventListener('click', () => { state.offset = 0; load(); }); $('clear-filters-button').addEventListener('click', () => { state.filters = {}; state.distinctValues = {}; renderFilters(); }); $('add-query-button').addEventListener('click', () => addQuery()); $('search-button').addEventListener('click', () => { state.offset = 0; load(); }); $('clear-search-button').addEventListener('click', clearAll); $('refresh-button').addEventListener('click', load); $('previous-page').addEventListener('click', () => { state.offset = Math.max(0, state.offset - PAGE_SIZE); load(); }); $('next-page').addEventListener('click', () => { state.offset += PAGE_SIZE; load(); }); $('select-all-button').addEventListener('click', () => { state.rows.forEach(row => state.selected.add(row.id)); renderRows(); }); $('copy-entry-id-button').addEventListener('click', () => openCopy(`Copy Entry ID (${state.selected.size})`, selectedRows().map(row => row.id).join(', '))); $('copy-sample-uuid-button').addEventListener('click', () => openCopy(`Copy Sample UUID (${state.selected.size})`, selectedRows().map(row => row.sample_uuid).filter(Boolean).join(', '))); $('copy-button').addEventListener('click', async () => { await navigator.clipboard.writeText($('copy-text').value); }); $('plot-selected-btn').addEventListener('click', plotSelected); $('plot-dataset').addEventListener('change', () => { populatePlotControls(); drawPlot(); }); ['x', 'y', 'z'].forEach(axis => { axisVariableSelect(axis).addEventListener('change', () => { populateAxisComponent(axis); drawPlot(); }); axisComponentSelect(axis).addEventListener('change', drawPlot); }); $('plot-mode').addEventListener('change', drawPlot); $('plot-z-color').addEventListener('change', drawPlot); $('update-plot').addEventListener('click', drawPlot); [['close-metadata', 'metadata-dialog'], ['close-data', 'data-dialog'], ['close-copy', 'copy-dialog']].forEach(([button, dialog]) => $(button).addEventListener('click', () => $(dialog).close())); $('close-plot').addEventListener('click', closePlot); $('error-close').addEventListener('click', () => showError());
  }
  document.addEventListener('DOMContentLoaded', () => { renderFilters(); addQuery(); setup(); if (standalonePlotEntries.length) { document.body.classList.add('plot-only'); plotEntries(standalonePlotEntries); } else load(); });
})();
