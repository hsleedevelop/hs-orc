/**
 * Electron 메인 프로세스 (PLAN S7, D-021).
 *
 * **`shell/` 만 교체한다.** Core·adapters·data 는 손대지 않는다 — Electron 은 Node 가 메인이라
 * v1 의 Core 를 그대로 쓴다. 이 파일은 **창과 IPC 배선만** 한다(로직은 `service.ts`).
 *
 * 렌더러는 Chromium 이라 TS 도 bare specifier 도 못 읽는다. 그래서 **렌더러만** esbuild 로 묶는다
 * (D-019 가 예고한 탈출구). 메인 프로세스는 타입 스트리핑 그대로다.
 */
import path from 'node:path';
import { BrowserWindow, app, dialog, ipcMain } from 'electron';
import { titleInfo } from '../tui/model.ts';
import { claudeSessions, codexSessions, reviews } from '../integrations.ts';
import { GuiService, type RunPayload } from './service.ts';
import type { SessionKind } from '../../core/transcript.ts';

const service = new GuiService();

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    // 타이틀바를 배경과 잇는다 — 창 위쪽에 회색 띠가 남으면 테마가 창 밖에서 끊긴다.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    title: titleInfo('Run').text,
    backgroundColor: '#1a1b26',
    webPreferences: {
      preload: path.resolve(import.meta.dirname, 'preload.cjs'),
      // 렌더러에 Node 를 열지 않는다. Core 접근은 preload 가 노출한 IPC 뿐이다.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });
  void window.loadFile(path.resolve(import.meta.dirname, 'renderer', 'index.html'));
}

ipcMain.handle('plan', (_e, payload: { task: string; write?: boolean; taskId?: string }) =>
  service.plan(payload.task, { write: payload.write === true, ...(payload.taskId ? { taskId: payload.taskId } : {}) }),
);
ipcMain.handle('tasks', () => service.tasks());
ipcMain.handle('run', (_e, payload: RunPayload) => service.run(payload));
ipcMain.handle('projects', () => service.projects());
ipcMain.handle('project-use', (_e, dir: string) => service.useProject(dir));
/**
 * 폴더 선택은 **메인 프로세스만** 할 수 있다 — 렌더러에 파일 시스템을 열지 않는다(D-021).
 * 취소하면 `null` 이다. 취소를 성공으로 바꿔 지금 폴더를 덮어쓰지 않는다.
 */
ipcMain.handle('project-pick', async (e) => {
  const parent = BrowserWindow.fromWebContents(e.sender);
  const result = await (parent
    ? dialog.showOpenDialog(parent, { properties: ['openDirectory', 'createDirectory'], defaultPath: service.cwd })
    : dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], defaultPath: service.cwd }));
  const dir = result.filePaths[0];
  if (result.canceled || dir === undefined) return null;
  return service.useProject(dir);
});
ipcMain.handle('worktrees', () => service.worktrees());
ipcMain.handle('worktree-create', (_e, payload: { name: string; from?: string }) =>
  service.createWorktree(payload.name, payload.from),
);
ipcMain.handle('worktree-remove', (_e, dir: string) => service.removeWorktree(dir));
ipcMain.handle('sessions', () => [claudeSessions(), codexSessions()]);
ipcMain.handle('reviews', () => reviews());
ipcMain.handle('dashboard', () => service.dashboard());
ipcMain.handle('debug', () => service.debug());
ipcMain.handle('crash-test', () => service.crashTest());
ipcMain.handle('conv-list', () => service.conversations());
ipcMain.handle('conv-start', (_e, kind: SessionKind) => service.startConversation(kind));
ipcMain.handle('conv-open', (_e, p: { kind: SessionKind; dir: string; id: string }) => service.openConversation(p.kind, p.dir, p.id));
ipcMain.handle('conv-view', () => service.conversation());
ipcMain.handle('conv-send', (_e, text: string) => service.converse(text));
ipcMain.handle('conv-plan-as', (_e, taskId: string) => service.conversePlanAs(taskId));
ipcMain.handle('conv-approve', (_e, p: { verify: string[]; write: boolean }) => service.converseApprove(p));
ipcMain.handle('conv-reject', () => service.converseReject());
ipcMain.handle('conv-close', () => service.closeConversation());

void app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
