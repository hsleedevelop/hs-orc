// 렌더러에 노출하는 유일한 통로. Node 는 열지 않는다 (contextIsolation: true).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orc', {
  plan: (payload) => ipcRenderer.invoke('plan', payload),
  run: (payload) => ipcRenderer.invoke('run', payload),
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
});
