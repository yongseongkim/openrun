import RFB from '/vendor/novnc/core/rfb.js';
import keysyms from '/vendor/novnc/core/input/keysymdef.js';

const $ = id => document.getElementById(id);
const requestId = location.pathname.split('/').pop();
let token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', location.pathname);
let rfb;
let poll;
let connected = false;
let terminal = false;
let expiresAt;

function message(title, description, badge) {
  $('title').textContent = title; $('description').textContent = description; $('status').textContent = badge;
}
function disconnect() { connected = false; rfb?.disconnect(); rfb = undefined; }
function connectDesktop() {
  if (terminal || connected) return;
  disconnect(); $('screen').replaceChildren();
  const url = new URL('/desktop/socket', location.origin); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  rfb = new RFB($('screen'), url.href, { shared: true });
  rfb.scaleViewport = true; rfb.resizeSession = false; rfb.background = '#20251f';
  rfb.addEventListener('connect', () => { connected = true; $('status').textContent = '브라우저 연결됨'; });
  rfb.addEventListener('disconnect', () => { connected = false; if (!terminal) $('status').textContent = '연결을 확인해 주세요'; });
}
async function status() {
  try {
    const result = await fetch('/api/viewer/status');
    if (!result.ok) throw new Error('expired');
    const { request, booking } = await result.json(); expiresAt = request.expiresAt;
    const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    $('remaining').textContent = `접속 가능 시간 ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
    if (request.state === 'BOOKING_REQUIRED') {
      $('desktop-section').hidden = false; $('booking-completion').hidden = false;
      document.title = '예약 진행 · OpenRun';
      $('booking-summary').textContent = booking ? `${booking.restaurantName} · ${booking.diningDate} ${booking.diningTime} · ${booking.partySize}명` : '요청한 날짜·시간·인원으로 예약해 주세요.';
      message('서버 브라우저에서 예약해 주세요.', '방문 날짜·시간·인원, 메뉴와 결제 및 취소 규정을 확인한 뒤 직접 예약을 확정해 주세요.', connected ? '브라우저 연결됨' : '예약 진행');
      if (!rfb) connectDesktop();
    } else if (request.state === 'AUTH_REQUIRED') {
      $('desktop-section').hidden = false;
      message('로그인 확인을 완료해 주세요.', '아래 서버 브라우저에서 로그인 또는 보안 문자를 입력해 주세요. 완료되면 자동으로 확인합니다.', connected ? '브라우저 연결됨' : '로그인 대기');
      if (!rfb) connectDesktop();
    } else if (request.state === 'CHECKING') {
      message('로그인 상태를 확인하고 있습니다.', '서버 브라우저를 준비하고 있습니다. 잠시만 기다려 주세요.', '확인 중');
    } else {
      terminal = true; clearInterval(poll); disconnect(); $('desktop-section').hidden = true; $('booking-completion').hidden = true;
      if (request.state === 'AUTHENTICATED') message('로그인이 완료됐습니다.', '로그인 상태를 안전하게 저장했습니다. 이제 이 창을 닫아도 됩니다.', '로그인 완료');
      else if (request.state === 'COMPLETED') message('예약 화면 접속을 종료했습니다.', '예약 확정 여부는 캐치테이블의 예약 내역에서 확인해 주세요. 이 창을 닫아도 됩니다.', '내역 확인 완료');
      else if (request.state === 'EXPIRED') message('접속 시간이 만료됐습니다.', '다시 시도하기 전 캐치테이블에서 예약 내역을 확인해 주세요.', '시간 만료');
      else message('로그인 상태를 확인하지 못했습니다.', request.error?.message ?? '새 로그인 링크로 다시 시도해 주세요.', '확인 필요');
    }
  } catch {
    terminal = true; clearInterval(poll); disconnect(); $('desktop-section').hidden = true;
    message('접속 링크를 확인해 주세요.', '링크가 만료됐거나 다른 기기에서 연결했을 수 있습니다. 새 링크를 요청해 주세요.', '접속 종료');
  }
}
async function join() {
  $('connect').disabled = true;
  try {
    if (token) {
      const result = await fetch('/api/viewer/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId, token }) });
      token = undefined;
      if (!result.ok) throw new Error('invalid');
    }
    $('connect').hidden = true;
    await status(); if (!terminal) poll = setInterval(status, 1500);
  } catch {
    message('링크를 사용할 수 없습니다.', '이미 사용했거나 만료된 링크입니다. 새 접속 링크를 요청해 주세요.', '접속 종료');
    $('connect').hidden = true;
  }
}
$('connect').addEventListener('click', join);
$('connect').textContent = '서버 브라우저 열기';
$('booking-confirmed').addEventListener('change', () => { $('booking-finish').disabled = !$('booking-confirmed').checked; });
$('booking-finish').addEventListener('click', async () => {
  $('booking-finish').disabled = true;
  try {
    const response = await fetch('/api/viewer/finish', { method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirmed:$('booking-confirmed').checked}) });
    if(!response.ok) throw new Error();
    await status();
  } catch { $('booking-finish').disabled = false; $('status').textContent = '연결을 확인한 뒤 다시 종료해 주세요.'; }
});
$('reconnect').addEventListener('click', () => { disconnect(); connectDesktop(); });
$('fullscreen').addEventListener('click', () => $('desktop-section').requestFullscreen?.());
$('fullscreen').disabled = !document.fullscreenEnabled;
$('scale-toggle').addEventListener('click', () => {
  if (!rfb) return;
  rfb.scaleViewport = !rfb.scaleViewport;
  rfb.clipViewport = !rfb.scaleViewport;
  rfb.dragViewport = !rfb.scaleViewport;
  $('scale-toggle').textContent = rfb.scaleViewport ? '화면 확대' : '화면 맞춤';
});
$('tab').addEventListener('click', () => rfb?.sendKey(0xff09, 'Tab'));
$('backspace').addEventListener('click', () => rfb?.sendKey(0xff08, 'Backspace'));
$('enter').addEventListener('click', () => rfb?.sendKey(0xff0d, 'Enter'));
$('keyboard-toggle').addEventListener('click', () => {
  const hidden = !$('keyboard-panel').hidden;
  $('keyboard-panel').hidden = hidden; $('keyboard-toggle').setAttribute('aria-expanded', String(!hidden));
  if (!hidden) $('mobile-input').focus();
});
let composing = false;
function sendText() {
  if (composing || !rfb) return;
  for (const char of $('mobile-input').value) {
    if (char === '\n') rfb.sendKey(0xff0d, 'Enter');
    else rfb.sendKey(keysyms.lookup(char.codePointAt(0)), undefined);
  }
  $('mobile-input').value = '';
}
$('mobile-input').addEventListener('compositionstart', () => { composing = true; });
$('mobile-input').addEventListener('compositionend', () => { composing = false; sendText(); });
$('mobile-input').addEventListener('input', sendText);
$('mobile-input').addEventListener('keydown', event => {
  if (event.key === 'Backspace' && !$('mobile-input').value && !composing) { rfb?.sendKey(0xff08, 'Backspace'); event.preventDefault(); }
  if (event.key === 'Tab') { rfb?.sendKey(0xff09, 'Tab'); event.preventDefault(); }
});
// Refreshing after token redemption resumes the cookie-bound connection.
if (!token) void join();
