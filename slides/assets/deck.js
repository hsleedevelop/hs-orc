// hs-orchestrator 덱 — 네비게이션 / 진행바 / 카운터 / 전체화면 / 발표자 노트
const slides = [...document.querySelectorAll('.slide')];
let current = 0;

function goTo(index) {
  if (index < 0 || index >= slides.length) return;
  slides[current].classList.remove('active');
  slides[index].classList.add('active');
  current = index;
  updateProgress();
  updateCounter();
  updateNotes();
  try { location.hash = 's' + (index + 1); } catch (e) {}
}

function updateProgress() {
  const el = document.getElementById('progress');
  if (el) el.style.width = (slides.length > 1 ? current / (slides.length - 1) * 100 : 100) + '%';
}

function updateCounter() {
  const el = document.getElementById('counter');
  if (el) el.textContent = (current + 1) + ' / ' + slides.length;
}

function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
  else document.exitFullscreen();
}

let notesWindow = null;

function toggleNotes() {
  if (notesWindow && !notesWindow.closed) { notesWindow.close(); notesWindow = null; return; }
  notesWindow = window.open('', 'SpeakerNotes', 'width=520,height=420,top=80,left=80');
  if (!notesWindow) return;
  notesWindow.document.write(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,sans-serif; background:#1a1a1a; color:#e0e0e0; padding:24px; }
  .slide-num { font-size:12px; color:#888; margin-bottom:12px; font-family:monospace; }
  .label { font-size:11px; letter-spacing:2px; text-transform:uppercase; color:#666; margin-bottom:8px; }
  .notes { font-size:16px; line-height:1.8; color:#ccc; }
</style></head><body>
  <div class="slide-num" id="sn"></div>
  <div class="label">Speaker Notes</div>
  <div class="notes" id="nt"></div>
</body></html>`);
  notesWindow.document.close();
  updateNotes();
}

function updateNotes() {
  if (!notesWindow || notesWindow.closed) return;
  try {
    notesWindow.document.getElementById('nt').textContent = slides[current].dataset.notes || '(노트 없음)';
    notesWindow.document.getElementById('sn').textContent = 'Slide ' + (current + 1) + ' / ' + slides.length;
  } catch (e) {}
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); goTo(current + 1); }
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goTo(current - 1); }
  if (e.key === 'Home') { e.preventDefault(); goTo(0); }
  if (e.key === 'End') { e.preventDefault(); goTo(slides.length - 1); }
  if (e.key.toLowerCase() === 'f') toggleFullscreen();
  if (e.key.toLowerCase() === 's') toggleNotes();
});

let touchStartX = 0;
document.addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX; }, { passive: true });
document.addEventListener('touchend', (e) => {
  const diff = touchStartX - e.changedTouches[0].clientX;
  if (Math.abs(diff) > 50) goTo(diff > 0 ? current + 1 : current - 1);
});

// 해시 → 슬라이드 인덱스
function indexFromHash() {
  const m = /^#s(\d+)$/.exec(location.hash);
  if (!m) return 0;
  return Math.min(Math.max(parseInt(m[1], 10) - 1, 0), slides.length - 1);
}

// 주소창에서 해시만 바꿔 들어오는 경우 (같은 문서 내 이동은 reload되지 않는다)
window.addEventListener('hashchange', () => {
  const target = indexFromHash();
  if (target !== current) goTo(target);
});

(function init() {
  const start = indexFromHash();
  slides.forEach((s, i) => s.classList.toggle('active', i === start));
  current = start;
  updateProgress();
  updateCounter();
})();
