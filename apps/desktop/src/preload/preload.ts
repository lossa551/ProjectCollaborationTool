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
  chooseWorkspace: () => ipcRenderer.invoke(Channel.chooseWorkspace),
  stopWorkspace: () => ipcRenderer.send(Channel.stopWorkspace),
  cloneRepo: () => ipcRenderer.invoke(Channel.cloneRepo),
  gitAction: (action) => ipcRenderer.invoke(Channel.gitAction, action),
  linkRepo: (repo) => ipcRenderer.invoke(Channel.linkRepo, repo),
  setGitHubToken: (token) => ipcRenderer.invoke(Channel.setGitHubToken, token),
  copyText: (text) => ipcRenderer.send(Channel.copyText, text),
  saveAgent: (agent) => ipcRenderer.invoke(Channel.saveAgent, agent),
  deleteAgent: (agentId) => ipcRenderer.send(Channel.deleteAgent, agentId),
  startAgent: (agentId) => ipcRenderer.invoke(Channel.startAgent, agentId),
  stopAgent: (agentId) => ipcRenderer.send(Channel.stopAgent, agentId),
  setApiKey: (name, key) => ipcRenderer.invoke(Channel.setApiKey, name, key),
  createChat: (request) => ipcRenderer.invoke(Channel.createChat, request),
  updateChat: (chatId, changes) => ipcRenderer.send(Channel.updateChat, chatId, changes),
  deleteChat: (chatId) => ipcRenderer.send(Channel.deleteChat, chatId),
  openChat: (chatId) => ipcRenderer.send(Channel.openChat, chatId),
  postChat: (chatId, text) => ipcRenderer.send(Channel.postChat, chatId, text),
  decideApproval: (chatId, messageId, approve) => ipcRenderer.send(Channel.decideApproval, chatId, messageId, approve),
  stopChat: (chatId) => ipcRenderer.send(Channel.stopChat, chatId),
  chatToTask: (chatId) => ipcRenderer.invoke(Channel.chatToTask, chatId),
  handOff: (request) => ipcRenderer.invoke(Channel.handOff, request),
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
