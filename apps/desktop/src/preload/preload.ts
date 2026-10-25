import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { Channel, type AppState, type PctApi } from '../common/api';

const api: PctApi = {
  getState: () => ipcRenderer.invoke(Channel.getState),
  host: (request) => ipcRenderer.invoke(Channel.host, request),
  join: (request) => ipcRenderer.invoke(Channel.join, request),
  leave: () => ipcRenderer.invoke(Channel.leave),
  setPresence: (status, focus) => ipcRenderer.send(Channel.setPresence, status, focus),
  copyText: (text) => ipcRenderer.send(Channel.copyText, text),
  onState(listener) {
    const handler = (_event: IpcRendererEvent, state: AppState) => listener(state);
    ipcRenderer.on(Channel.state, handler);
    return () => ipcRenderer.off(Channel.state, handler);
  },
};

contextBridge.exposeInMainWorld('pct', api);
