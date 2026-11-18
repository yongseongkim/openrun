const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const dateLabel = value => new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'long',day:'numeric',weekday:'short',hour:'numeric',minute:'2-digit'}).format(value);
const errors = {OWNER_SESSION_REQUIRED:'관리 링크로 다시 접속해 주세요.',LINK_EXPIRED_OR_USED:'새 관리 링크로 접속해 주세요.',WAITING_OPENING_CHANGED:'접수 시간이 바뀌었습니다. 표시된 시간을 확인하고 다시 신청해 주세요.',WAITING_REGISTRATION_NOT_OPEN:'명부는 접수 전날부터 작성할 수 있어요.',INVALID_WAITING_PHONE:'휴대전화 번호를 확인해 주세요.',INVALID_PARTY_SIZE:'신청 인원을 확인해 주세요.',WAITING_ALREADY_EXISTS:'이미 명부에 있는 전화번호입니다.',WAITING_STATE_CHANGED:'접수가 시작되어 명부에서 삭제할 수 없습니다.',WAITING_UNAVAILABLE:'웨이팅 서비스를 준비 중입니다.'};
let token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null,'',location.pathname);
let data, loading = false, timer, poll;
async function api(path, body) {
  const response = await fetch(path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok){const error=new Error(errors[result.error]??'요청을 처리하지 못했습니다. 입력 내용과 서버 연결을 확인해 주세요.');error.status=response.status;error.code=result.error;throw error;}
  return result;
}
function notice(message){$('notice').textContent=message;$('notice').hidden=false;clearTimeout(timer);timer=setTimeout(()=>{$('notice').hidden=true;},8000);}
function render(){
  const opening=data.nextOpening;
  $('next-run').textContent=dateLabel(opening.opensAt);
  $('registration-note').textContent=opening.canRegister?'이 시간의 명부만 작성합니다. 다음 접수에도 원하면 다시 신청해 주세요.':`${dateLabel(opening.registrationOpensAt)}부터 명부를 작성할 수 있어요.`;
  $('waiting-fields').disabled=!opening.canRegister;
  $('waiting-form').elements.partySize.max=data.restaurant.maxPartySize;
  $('catchtable-nav').hidden=!data.features?.catchtable;
  $('syrup-link').href=data.restaurant.url;
  const entries=data.jobs.filter(job=>job.opensAt===opening.opensAt&&!['CANCELLED','FAILED','EXPIRED'].includes(job.state));
  $('roster-count').textContent=`${entries.length}건`;
  $('waiting-jobs').innerHTML=entries.map(job=>`<article class="roster-entry"><div><strong>${job.partySize}명</strong><span>${esc(job.phoneMasked)}</span></div>${job.state==='SCHEDULED'?`<button data-cancel="${esc(job.id)}" aria-label="${esc(job.phoneMasked)} 명부에서 삭제">삭제</button>`:''}</article>`).join('')||'<div class="empty">아직 명부가 비어 있어요.</div>';
}
async function refresh(){
  if(loading)return;loading=true;
  try{
    const next=await api('/api/app/waiting');
    const changed=data&&data.nextOpening.id!==next.nextOpening.id;
    data=next;$('gate').hidden=true;$('waiting-app').hidden=false;render();
    if(changed)notice('다음 접수 시간이 바뀌었습니다. 표시된 시간을 확인해 주세요.');
  }
  catch(error){if(!data||error.status===401){$('gate').hidden=false;$('waiting-app').hidden=true;$('gate-description').textContent=error.message;}}
  finally{loading=false;}
}
$('waiting-form').onsubmit=async event=>{
  event.preventDefault();const form=event.currentTarget,button=event.submitter;
  const payload={partySize:form.elements.partySize.value,phoneNumber:form.elements.phoneNumber.value,openingId:data.nextOpening.id,confirmed:true};
  button.disabled=true;form.querySelector('.form-error').textContent='';
  try{await api('/api/app/waiting',payload);form.elements.phoneNumber.value='';await refresh();notice('이번 접수 명부에 추가했습니다.');}
  catch(error){form.querySelector('.form-error').textContent=error.message;if(error.code==='WAITING_OPENING_CHANGED')await refresh();}
  finally{button.disabled=false;}
};
$('waiting-jobs').onclick=async event=>{
  const button=event.target.closest('button[data-cancel]');if(!button)return;button.disabled=true;
  try{await api(`/api/app/waiting/${button.dataset.cancel}/cancel`,{});await refresh();notice('명부에서 삭제했습니다.');}
  catch(error){notice(error.message);}finally{button.disabled=false;}
};
$('join').onclick=async()=>{
  $('join').disabled=true;
  try{await api('/api/console/exchange',{token});token=undefined;await refresh();}
  catch(error){$('gate-description').textContent=error.message;}
  finally{$('join').disabled=false;}
};
if(token)$('join').hidden=false;else void refresh();
window.addEventListener('hashchange',()=>{
  const incoming=new URLSearchParams(location.hash.slice(1)).get('token');
  if(!incoming)return;
  history.replaceState(null,'',location.pathname);token=incoming;data=undefined;
  $('gate').hidden=false;$('waiting-app').hidden=true;$('join').hidden=false;
});
poll=setInterval(()=>{if(data)void refresh();},10000);window.addEventListener('pagehide',()=>clearInterval(poll));
