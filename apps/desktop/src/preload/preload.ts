import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { Channel, type AppState, type PctApi, type UpdateInfo } from '../common/api';

const api: PctApi = {
  getState: () => ipcRenderer.invoke(Channel.getState),
  host: (request) => ipcRenderer.invoke(Channel.host, request),
  join: (request) => ipcRenderer.invoke(Channel.join, request),
  leave: () => ipcRenderer.invoke(Channel.leave),
  setPresence: (status, focus) => ipcRenderer.send(Channel.setPresence, status, focus),
  createTask: (title, stage) => ipcRenderer.send(Channel.createTask, title, stage),
  updateTask: (taskId, changes) => ipcRenderer.send(Channel.updateTask, taskId, changes),
  deleteTask: (taskId) => ipcRenderer.send(Channel.deleteTask, taskId),
  acquireLock: (path, options) => ipcRenderer.send(Channel.acquireLock, path, options),
  releaseLock: (lockId) => ipcRenderer.send(Channel.releaseLock, lockId),
  recoverLock: (lockId) => ipcRenderer.send(Channel.recoverLock, lockId),
  setLockRules: (rules) => ipcRenderer.send(Channel.setLockRules, rules),
  copyText: (text) => ipcRenderer.send(Channel.copyText, text),
  onState(listener) {
    const handler = (_event: IpcRendererEvent, state: AppState) => listener(state);
    ipcRenderer.on(Channel.state, handler);
    return () => ipcRenderer.off(Channel.state, handler);
  },
  getUpdate: () => ipcRenderer.invoke(Channel.getUpdate),
  update: () => ipcRenderer.invoke(Channel.update),
  onUpdate(listener) {
    const handler = (_event: IpcRendererEvent, info: UpdateInfo) => listener(info);
    ipcRenderer.on(Channel.updateState, handler);
    return () => ipcRenderer.off(Channel.updateState, handler);
  },
};

contextBridge.exposeInMainWorld('pct', api);
