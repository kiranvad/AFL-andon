const { contextBridge, ipcRenderer } = require('electron');

const tiledBrowser = {
  search: (serverName, options) => ipcRenderer.invoke('tiled-search', serverName, options),
  metadata: (serverName, entryId) => ipcRenderer.invoke('tiled-metadata', serverName, entryId),
  fullData: (serverName, entryId) => ipcRenderer.invoke('tiled-full-data', serverName, entryId),
  dataPreview: (serverName, entryId) => ipcRenderer.invoke('tiled-data-preview', serverName, entryId),
  containerData: (serverName, entryId) => ipcRenderer.invoke('tiled-container-data', serverName, entryId),
  distinct: (serverName, field, filters) => ipcRenderer.invoke('tiled-distinct', serverName, field, filters),
  openPlot: (serverName, entryIds) => ipcRenderer.invoke('tiled-open-plot', serverName, entryIds)
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('tiledBrowser', tiledBrowser);
} else {
  window.tiledBrowser = tiledBrowser;
}
