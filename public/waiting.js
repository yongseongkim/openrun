const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const dateLabel = value => new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'long',day:'numeric',weekday:'long'}).format(new Date(`${value}T12:00:00+09:00`));
const states = {SCHEDULED:'실행 대기',RUNNING:'접수 진행 중',SUBMITTING:'최종 제출 중',SUCCEEDED:'웨이팅 등록 완료',UNKNOWN:'제출 결과 확인 필요',FAILED:'등록 확인 필요',EXPIRED:'실행 시간 만료',CANCELLED:'신청 취소',INTERRUPTED:'중단 · 내역 확인 필요'};
const errors = {OWNER_SESSION_REQUIRED:'관리 링크로 다시 접속해 주세요.',WAITING_TOMORROW_ONLY:'한국 시간으로 다음날 신청만 가능합니다. 날짜를 다시 확인해 주세요.',WAITING_CLOSED_DAY:'내일은 휴무 예정일입니다.',INVALID_WAITING_PHONE:'휴대전화 번호를 확인해 주세요.',INVALID_PARTY_SIZE:'신청 인원을 확인해 주세요.',WAITING_ALREADY_EXISTS:'같은 날짜·시간대의 신청이 이미 있습니다. 기존 신청 내역을 확인해 주세요.',WAITING_STATE_CHANGED:'이미 실행이 시작됐거나 신청 상태가 바뀌었습니다. 시럽 내역을 확인해 주세요.',WAITING_CONFIRMATION_REQUIRED:'실제 웨이팅 등록에 동의해 주세요.',WAITING_UNAVAILABLE:'웨이팅 서비스를 준비 중입니다.'};
let data, loading = false, timer, poll;
async function api(path, body) {
  const response = await fetch(path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok){const error=new Error(errors[result.error]??'요청을 처리하지 못했습니다. 입력 내용과 서버 연결을 확인해 주세요.');error.status=response.status;throw error;}
  return result;
}
function notice(message){$('notice').textContent=message;$('notice').hidden=false;clearTimeout(timer);timer=setTimeout(()=>{$('notice').hidden=true;},8000);}
function render(){
  $('tomorrow-label').textContent=dateLabel(data.tomorrow.date);
  $('waiting-form').elements.visitDate.value=data.tomorrow.date;
  $('waiting-form').elements.partySize.max=data.restaurant.maxPartySize;
  $('waiting-fields').disabled=data.tomorrow.closed;
  $('closed-notice').hidden=!data.tomorrow.closed;
  $('syrup-link').href=data.restaurant.url;
  $('waiting-jobs').innerHTML=data.jobs.map(job=>`<article class="job"><div><span class="badge waiting-state ${['UNKNOWN','FAILED','INTERRUPTED'].includes(job.state)?'warning':'neutral'}">${esc(states[job.state]??job.state)}</span><h3>${esc(job.visitDate)} · ${job.slot==='am'?'오전 10:00':'오후 16:00'}</h3><p>나니요리 · ${job.partySize}명 · ${esc(job.phoneMasked)}</p>${job.message?`<p class="detail">${esc(job.message)}</p>`:''}${job.result?`<div class="waiting-result"><p>대기 번호 <strong>${esc(job.result.waitNumber)}</strong></p><p>앞 팀 수 ${esc(job.result.teamsAhead)}</p><p>등록 시간 ${esc(job.result.registrationTime)}</p></div>`:''}${job.notify?`<p class="detail">Slack 알림 ${job.notification==='SENT'?'전송 완료':job.notification==='FAILED'?'전송 실패 · 신청 결과를 확인해 주세요':'요청됨'}</p>`:''}</div>${job.state==='SCHEDULED'?`<div class="job-actions"><button data-cancel="${esc(job.id)}">신청 취소</button></div>`:''}</article>`).join('')||'<div class="empty">아직 웨이팅 신청이 없습니다.<br>내일의 방문 인원과 연락처를 입력해 주세요.</div>';
}
async function refresh(){
  if(loading)return;loading=true;
  try{
    const next=await api('/api/app/waiting');
    if(data&&data.tomorrow.date!==next.tomorrow.date){$('waiting-form').elements.confirmed.checked=false;notice('한국 시간 날짜가 바뀌었습니다. 방문 날짜를 다시 확인하고 등록에 동의해 주세요.');}
    data=next;$('gate').hidden=true;$('waiting-app').hidden=false;render();
  }
  catch(error){if(!data||error.status===401){$('gate').hidden=false;$('waiting-app').hidden=true;$('gate-description').textContent=error.message;}}
  finally{loading=false;}
}
$('waiting-form').onsubmit=async event=>{
  event.preventDefault();const form=event.currentTarget,button=event.submitter;
  const payload=Object.fromEntries(new FormData(form));payload.restaurantId='naniyori';payload.notify=form.elements.notify.checked;payload.confirmed=form.elements.confirmed.checked;
  button.disabled=true;form.querySelector('.form-error').textContent='';
  try{await api('/api/app/waiting',payload);form.elements.phoneNumber.value='';form.elements.confirmed.checked=false;await refresh();notice('내일 웨이팅 신청을 저장했습니다. 선택한 시각에 서버가 실제 접수를 시도합니다.');}
  catch(error){form.querySelector('.form-error').textContent=error.message;}
  finally{button.disabled=false;}
};
$('waiting-jobs').onclick=async event=>{
  const button=event.target.closest('button[data-cancel]');if(!button)return;button.disabled=true;
  try{await api(`/api/app/waiting/${button.dataset.cancel}/cancel`,{});await refresh();notice('자동 실행 신청을 취소했습니다.');}
  catch(error){notice(error.message);}finally{button.disabled=false;}
};
void refresh();poll=setInterval(refresh,3000);window.addEventListener('pagehide',()=>clearInterval(poll));
