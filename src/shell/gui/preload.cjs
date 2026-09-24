// 렌더러에 노출하는 유일한 통로. Node 는 열지 않는다 (contextIsolation: true).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orc', {
  tasks: () => ipcRenderer.invoke('tasks'),
  projects: () => ipcRenderer.invoke('projects'),
  pickProject: () => ipcRenderer.invoke('project-pick'),
  useProject: (dir) => ipcRenderer.invoke('project-use', dir),
  worktrees: () => ipcRenderer.invoke('worktrees'),
  createWorktree: (payload) => ipcRenderer.invoke('worktree-create', payload),
  removeWorktree: (dir) => ipcRenderer.invoke('worktree-remove', dir),
  sessions: () => ipcRenderer.invoke('sessions'),
  reviews: () => ipcRenderer.invoke('reviews'),
  dashboard: () => ipcRenderer.invoke('dashboard'),
  debug: () => ipcRenderer.invoke('debug'),
  crashTest: () => ipcRenderer.invoke('crash-test'),
  convList: () => ipcRenderer.invoke('conv-list'),
  convStart: (kind) => ipcRenderer.invoke('conv-start', kind),
  convOpen: (payload) => ipcRenderer.invoke('conv-open', payload),
  convView: () => ipcRenderer.invoke('conv-view'),
  convSend: (text) => ipcRenderer.invoke('conv-send', text),
  convPlanAs: (taskId) => ipcRenderer.invoke('conv-plan-as', taskId),
  convApprove: (payload) => ipcRenderer.invoke('conv-approve', payload),
  convReject: () => ipcRenderer.invoke('conv-reject'),
  convAsk: () => ipcRenderer.invoke('conv-ask'),
  convClose: () => ipcRenderer.invoke('conv-close'),
});
