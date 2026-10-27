import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { NeedTarget } from '@pct/shared';
import { Channel, type AppState, type PctApi, type UpdateInfo } from '../common/api';

const api: PctApi = {
  getState: () => ipcRenderer.invoke(Channel.getState),
  host: (request) => ipcRenderer.invoke(Channel.host, request),
  join: (request) => ipcRenderer.invoke(Channel.join, request),
  listSessions: () => ipcRenderer.invoke(Channel.listSessions),
  resume: (request) => ipcRenderer.invoke(Channel.resume, request),
  forgetSession: (key) => ipcRenderer.invoke(Channel.forgetSession, key),
  listBackups: (key) => ipcRenderer.invoke(Channel.listBackups, key),
  restoreBackup: (key, path) => ipcRenderer.invoke(Channel.restoreBackup, key, path),
  getBackupFolder: () => ipcRenderer.invoke(Channel.getBackupFolder),
  createSnapshot: (request) => ipcRenderer.invoke(Channel.createSnapshot, request),
  deleteSnapshot: (key, path) => ipcRenderer.invoke(Channel.deleteSnapshot, key, path),
  setBackupFolder: (choose) => ipcRenderer.invoke(Channel.setBackupFolder, choose),
  exportMemory: () => ipcRenderer.invoke(Channel.exportMemory),
  setMemoryAutoExport: (on) => ipcRenderer.send(Channel.setMemoryAutoExport, on),
  setNoticeMuted: (kind, muted) => ipcRenderer.send(Channel.setNoticeMuted, kind, muted),
  testNotice: () => ipcRenderer.send(Channel.testNotice),
  onOpenTarget(listener) {
    const handler = (_event: IpcRendererEvent, target: NeedTarget | null) => listener(target);
    ipcRenderer.on(Channel.openTarget, handler);
    return () => ipcRenderer.off(Channel.openTarget, handler);
  },
  leave: () => ipcRenderer.invoke(Channel.leave),
  newInvite: () => ipcRenderer.invoke(Channel.newInvite),
  removeParticipant: (participantId) => ipcRenderer.invoke(Channel.removeParticipant, participantId),
  setPresence: (status, focus) => ipcRenderer.send(Channel.setPresence, status, focus),
  createTask: (title, stage) => ipcRenderer.send(Channel.createTask, title, stage),
  updateTask: (taskId, changes) => ipcRenderer.send(Channel.updateTask, taskId, changes),
  deleteTask: (taskId) => ipcRenderer.send(Channel.deleteTask, taskId),
  acquireLock: (path, options) => ipcRenderer.send(Channel.acquireLock, path, options),
  releaseLock: (lockId) => ipcRenderer.send(Channel.releaseLock, lockId),
  recoverLock: (lockId) => ipcRenderer.send(Channel.recoverLock, lockId),
  setLockRules: (rules) => ipcRenderer.send(Channel.setLockRules, rules),
  setPrices: (prices) => ipcRenderer.send(Channel.setPrices, prices),
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
  branchChat: (request) => ipcRenderer.invoke(Channel.branchChat, request),
  updateChat: (chatId, changes) => ipcRenderer.send(Channel.updateChat, chatId, changes),
  deleteChat: (chatId) => ipcRenderer.invoke(Channel.deleteChat, chatId),
  worktreeAction: (chatId, action) => ipcRenderer.invoke(Channel.worktreeAction, chatId, action),
  worktreeDiff: (chatId) => ipcRenderer.invoke(Channel.worktreeDiff, chatId),
  openChat: (chatId) => ipcRenderer.send(Channel.openChat, chatId),
  postChat: (chatId, text) => ipcRenderer.send(Channel.postChat, chatId, text),
  decideApproval: (chatId, messageId, approve) => ipcRenderer.send(Channel.decideApproval, chatId, messageId, approve),
  stopChat: (chatId) => ipcRenderer.send(Channel.stopChat, chatId),
  undoTurn: (chatId, messageId, mode) => ipcRenderer.send(Channel.undoTurn, chatId, messageId, mode),
  chatToTask: (chatId) => ipcRenderer.invoke(Channel.chatToTask, chatId),
  handOff: (request) => ipcRenderer.invoke(Channel.handOff, request),
  createIssue: (request) => ipcRenderer.invoke(Channel.createIssue, request),
  closeIssue: (number, comment) => ipcRenderer.invoke(Channel.closeIssue, number, comment),
  editPlanning: (op) => ipcRenderer.send(Channel.editPlanning, op),
  approvePlan: (approval) => ipcRenderer.invoke(Channel.approvePlan, approval),
  editMemory: (op) => ipcRenderer.send(Channel.editMemory, op),
  verifyCriterion: (taskId, criterionId, state, evidence) => ipcRenderer.send(Channel.verifyCriterion, taskId, criterionId, state, evidence),
  runBloatCheck: () => ipcRenderer.invoke(Channel.runBloatCheck),
  scanFolderNotes: (fresh) => ipcRenderer.invoke(Channel.scanFolderNotes, fresh),
  folderNoteTask: (folder) => ipcRenderer.invoke(Channel.folderNoteTask, folder),
  folderNotePaths: () => ipcRenderer.invoke(Channel.folderNotePaths),
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
