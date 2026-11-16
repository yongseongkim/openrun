const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const dateLabel = value => new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'long',day:'numeric',weekday:'long'}).format(new Date(`${value}T12:00:00+09:00`));
const states = {SCHEDULED:'실행 대기',RUNNING:'접수 진행 중',SUBMITTING:'최종 제출 중',SUCCEEDED:'웨이팅 등록 완료',UNKNOWN:'제출 결과 확인 필요',FAILED:'등록 확인 필요',EXPIRED:'실행 시간 만료',CANCELLED:'신청 취소',INTERRUPTED:'중단 · 내역 확인 필요'};
const errors = {OWNER_SESSION_REQUIRED:'관리 링크로 다시 접속해 주세요.',LINK_EXPIRED_OR_USED:'이미 사용했거나 만료된 링크입니다. 새 관리 링크를 열어 주세요.',INVALID_WAITING_DATE:'방문 날짜를 확인해 주세요.',WAITING_DATE_OUT_OF_RANGE:'신청 가능한 날짜 범위를 벗어났습니다. 날짜를 다시 확인해 주세요.',WAITING_CLOSED_DAY:'선택한 날짜는 휴무 예정일입니다.',INVALID_WAITING_PHONE:'휴대전화 번호를 확인해 주세요.',INVALID_PARTY_SIZE:'신청 인원을 확인해 주세요.',WAITING_ALREADY_EXISTS:'같은 날짜·시간대의 신청이 이미 있습니다. 기존 신청 내역을 확인해 주세요.',WAITING_STATE_CHANGED:'이미 실행이 시작됐거나 신청 상태가 바뀌었습니다. 시럽 내역을 확인해 주세요.',WAITING_CONFIRMATION_REQUIRED:'실제 웨이팅 등록에 동의해 주세요.',WAITING_UNAVAILABLE:'웨이팅 서비스를 준비 중입니다.'};
const kstTime = value => new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(value);
let token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null,'',location.pathname);
let data, loading = false, timer, poll;
async function api(path, body) {
  const response = await fetch(path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok){const error=new Error(errors[result.error]??'요청을 처리하지 못했습니다. 입력 내용과 서버 연결을 확인해 주세요.');error.status=response.status;throw error;}
  return result;
}
function notice(message){$('notice').textContent=message;$('notice').hidden=false;clearTimeout(timer);timer=setTimeout(()=>{$('notice').hidden=true;},8000);}
function render(){
  const dateInput=$('waiting-form').elements.visitDate,bookingWindow=data.bookingWindow;
  dateInput.min=bookingWindow.minDate;dateInput.max=bookingWindow.maxDate;
  if(!dateInput.value||dateInput.value<bookingWindow.minDate||dateInput.value>bookingWindow.maxDate)dateInput.value=bookingWindow.defaultDate;
  const date=dateInput.value,closed=data.restaurant.closedWeekdays.includes(new Date(`${date}T12:00:00+09:00`).getUTCDay());
  $('tomorrow-label').textContent=dateLabel(date);
  $('waiting-form').elements.partySize.max=data.restaurant.maxPartySize;
  $('waiting-fields').disabled=closed;
  $('closed-notice').hidden=!closed;
  $('catchtable-nav').hidden=!data.features?.catchtable;
  $('syrup-link').href=data.restaurant.url;
  const next=data.jobs.filter(job=>job.state==='SCHEDULED').sort((a,b)=>a.opensAt-b.opensAt)[0];
  $('next-run').textContent=next?`다음 접수: ${dateLabel(next.visitDate)} ${kstTime(next.runsAt)} · ${next.partySize}명`:'신청한 일정에만 접수합니다. 방문 날짜를 선택해 주세요.';
  $('waiting-jobs').innerHTML=data.jobs.map(job=>`<article class="job"><div><span class="badge waiting-state ${['UNKNOWN','FAILED','INTERRUPTED'].includes(job.state)?'warning':'neutral'}">${esc(states[job.state]??job.state)}</span><h3>${esc(job.visitDate)} · ${job.slot==='am'?'오전 10:00':'오후 16:00'}</h3><p>나니요리 · ${job.partySize}명 · ${esc(job.phoneMasked)}</p><p class="detail">미리 준비 ${esc(kstTime(job.prepareAt))} · 접수 시도 ${esc(kstTime(job.runsAt))}</p>${job.message?`<p class="detail">${esc(job.message)}</p>`:''}${job.result?`<div class="waiting-result"><p>대기 번호 <strong>${esc(job.result.waitNumber)}</strong></p><p>앞 팀 수 ${esc(job.result.teamsAhead)}</p><p>등록 시간 ${esc(job.result.registrationTime)}</p></div>`:''}${job.notify?`<p class="detail">Slack 알림 ${job.notification==='SENT'?'전송 완료':job.notification==='FAILED'?'전송 실패 · 신청 결과를 확인해 주세요':'요청됨'}</p>`:''}</div>${job.state==='SCHEDULED'?`<div class="job-actions"><button data-cancel="${esc(job.id)}">신청 취소</button></div>`:''}</article>`).join('')||'<div class="empty">아직 웨이팅 신청이 없습니다.<br>방문 날짜·인원과 연락처를 입력해 주세요.</div>';
}
async function refresh(){
  if(loading)return;loading=true;
  try{
    const next=await api('/api/app/waiting');
    const selected=$('waiting-form').elements.visitDate.value;
    if(data&&selected&&(selected<next.bookingWindow.minDate||selected>next.bookingWindow.maxDate)){$('waiting-form').elements.confirmed.checked=false;notice('신청 가능한 날짜가 바뀌었습니다. 방문 날짜를 다시 확인하고 등록에 동의해 주세요.');}
    data=next;$('gate').hidden=true;$('waiting-app').hidden=false;render();
  }
  catch(error){if(!data||error.status===401){$('gate').hidden=false;$('waiting-app').hidden=true;$('gate-description').textContent=error.message;}}
  finally{loading=false;}
}
$('waiting-form').onsubmit=async event=>{
  event.preventDefault();const form=event.currentTarget,button=event.submitter;
  const payload=Object.fromEntries(new FormData(form));payload.restaurantId='naniyori';payload.notify=form.elements.notify.checked;payload.confirmed=form.elements.confirmed.checked;
  button.disabled=true;form.querySelector('.form-error').textContent='';
  try{await api('/api/app/waiting',payload);form.elements.phoneNumber.value='';form.elements.confirmed.checked=false;await refresh();notice('웨이팅 신청을 저장했습니다. 선택한 날짜·시각에 서버가 실제 접수를 시도합니다.');}
  catch(error){form.querySelector('.form-error').textContent=error.message;}
  finally{button.disabled=false;}
};
$('waiting-jobs').onclick=async event=>{
  const button=event.target.closest('button[data-cancel]');if(!button)return;button.disabled=true;
  try{await api(`/api/app/waiting/${button.dataset.cancel}/cancel`,{});await refresh();notice('자동 실행 신청을 취소했습니다.');}
  catch(error){notice(error.message);}finally{button.disabled=false;}
};
$('waiting-form').elements.visitDate.onchange=()=>{$('waiting-form').elements.confirmed.checked=false;if(data)render();};
$('join').onclick=async()=>{
  $('join').disabled=true;
  try{await api('/api/console/exchange',{token});token=undefined;await refresh();}
  catch(error){$('gate-description').textContent=error.message;}
  finally{$('join').disabled=false;}
};
if(token)$('join').hidden=false;else void refresh();
// Opening a new management link in this same tab can be a fragment-only
// navigation, so the module will not reload. Still require the explicit button.
window.addEventListener('hashchange',()=>{
  const incoming=new URLSearchParams(location.hash.slice(1)).get('token');
  if(!incoming)return;
  history.replaceState(null,'',location.pathname);token=incoming;data=undefined;
  $('gate').hidden=false;$('waiting-app').hidden=true;$('join').hidden=false;
});
poll=setInterval(()=>{if(data)void refresh();},3000);window.addEventListener('pagehide',()=>clearInterval(poll));
