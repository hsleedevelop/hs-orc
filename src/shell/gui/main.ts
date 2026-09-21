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
import { BrowserWindow, app, ipcMain } from 'electron';
import { titleInfo } from '../tui/model.ts';
import { claudeSessions, codexSessions, reviews } from '../integrations.ts';
import { GuiService, type RunPayload } from './service.ts';

const service = new GuiService();

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    title: titleInfo('Run').text,
    backgroundColor: '#10131a',
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

ipcMain.handle('plan', (_e, payload: { task: string; write?: boolean }) =>
  service.plan(payload.task, { write: payload.write === true }),
);
ipcMain.handle('run', (_e, payload: RunPayload) => service.run(payload));
ipcMain.handle('sessions', () => [claudeSessions(), codexSessions()]);
ipcMain.handle('reviews', () => reviews());
ipcMain.handle('dashboard', () => service.dashboard());
ipcMain.handle('debug', () => service.debug());
ipcMain.handle('crash-test', () => service.crashTest());

void app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
