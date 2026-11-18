const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dateLabel=value=>new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'long',day:'numeric',weekday:'short',hour:'numeric',minute:'2-digit'}).format(value);
export const messages={WAITING_OPENING_CHANGED:'명부의 날짜가 바뀌었습니다. 내일 접수 날짜를 확인하고 다시 신청해 주세요.',WAITING_CLOSED_DAY:'내일은 매장 휴무 예정일입니다.',INVALID_WAITING_PHONE:'휴대전화 번호를 확인해 주세요.',INVALID_PARTY_SIZE:'신청 인원을 확인해 주세요.',WAITING_STATE_CHANGED:'접수가 시작된 신청은 수정할 수 없습니다. 신청자와 연락해 시럽 내역을 확인해 주세요.',WAITING_UNAVAILABLE:'웨이팅 서비스를 준비 중입니다.'};
export function createWaitingPanel({api,notice}) {
let data,loading=false,editingId,editingOpeningId;
function render(){
  const opening=data.nextOpening;
  $('next-run').textContent=dateLabel(opening.opensAt);
  $('registration-note').textContent=opening.closed?'내일은 매장 휴무 예정일이라 신청을 받지 않아요.':'명부에 남긴 인원수와 전화번호로 내일 오전 10시에 웨이팅을 시도합니다.';
  $('waiting-fields').disabled=!opening.canRegister;
  $('waiting-form').elements.partySize.max=data.restaurant.maxPartySize;
  $('syrup-link').href=data.restaurant.url;
  const entries=data.jobs.filter(job=>job.opensAt===opening.opensAt&&!['CANCELLED','FAILED','EXPIRED'].includes(job.state));
  $('roster-count').textContent=`${entries.length}건`;
  $('waiting-jobs').innerHTML=entries.map(job=>`<article class="roster-entry"><div class="roster-contact"><strong>${job.partySize}명</strong><span>${esc(job.phoneMasked)}</span></div>${job.state==='SCHEDULED'?(editingId===job.id?`<form data-resize="${esc(job.id)}" class="roster-edit"><label><span class="sr-only">수정할 인원수</span><input name="partySize" aria-label="수정할 인원수" type="number" min="1" max="${data.restaurant.maxPartySize}" value="${job.partySize}" required></label><button type="submit">저장</button><button type="button" data-close-edit>닫기</button></form>`:`<div class="roster-actions"><button data-edit="${esc(job.id)}">인원 수정</button><button data-cancel="${esc(job.id)}">삭제</button></div>`):''}</article>`).join('')||'<div class="empty">아직 신청한 사람이 없어요.<br>함께 갈 사람과 이야기하고 명부에 남겨주세요.</div>';
}
async function refresh(){
  if(loading)return;loading=true;
  try{
    const next=await api('/api/app/waiting'),changed=data&&data.nextOpening.id!==next.nextOpening.id;
    data=next;
    if(changed){editingId=undefined;notice('날짜가 바뀌어 새 내일 접수 명부를 열었습니다.');}
    if(editingId&&!next.jobs.some(job=>job.id===editingId&&job.state==='SCHEDULED'))editingId=undefined;
    if(!editingId)render();
  }finally{loading=false;}
}
$('waiting-form').onsubmit=async event=>{
  event.preventDefault();const form=event.currentTarget,button=event.submitter;
  button.disabled=true;form.querySelector('.form-error').textContent='';
  try{await api('/api/app/waiting',{partySize:form.elements.partySize.value,phoneNumber:form.elements.phoneNumber.value,openingId:data.nextOpening.id,confirmed:true});form.elements.phoneNumber.value='';editingId=undefined;await refresh();notice('명부를 저장했습니다. 인원 변경은 함께 갈 사람에게 알려주세요.');}
  catch(error){form.querySelector('.form-error').textContent=error.message;if(error.code==='WAITING_OPENING_CHANGED')await refresh();}
  finally{button.disabled=false;}
};
$('waiting-jobs').onclick=async event=>{
  const button=event.target.closest('button');if(!button)return;
  if(button.dataset.edit){editingId=button.dataset.edit;editingOpeningId=data.nextOpening.id;render();$('waiting-jobs').querySelector('[name=partySize]')?.focus();return;}
  if(button.hasAttribute('data-close-edit')){editingId=undefined;render();return;}
  if(!button.dataset.cancel)return;button.disabled=true;
  try{await api(`/api/app/waiting/${button.dataset.cancel}/cancel`,{});editingId=undefined;await refresh();notice('명부에서 삭제했습니다. 함께 갈 사람에게도 알려주세요.');}
  catch(error){notice(error.message);}finally{button.disabled=false;}
};
$('waiting-jobs').onsubmit=async event=>{
  const form=event.target.closest('form[data-resize]');if(!form)return;event.preventDefault();const button=event.submitter;button.disabled=true;
  try{await api(`/api/app/waiting/${form.dataset.resize}/resize`,{partySize:form.elements.partySize.value,openingId:editingOpeningId,confirmed:true});editingId=undefined;await refresh();notice('인원수를 수정했습니다. 함께 갈 사람에게 변경 내용을 알려주세요.');}
  catch(error){notice(error.message);if(error.code==='WAITING_OPENING_CHANGED')await refresh();}finally{button.disabled=false;}
};
return {select:async()=>{editingId=undefined;await refresh();},refresh};
}
