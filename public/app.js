const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const kst = value => new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(value);
const localKst = value => new Date(value + 9 * 3600000).toISOString().slice(0,16);
let token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', location.pathname);
let data, timer, refreshTimer, refreshing = false;
const messages = {OWNER_SESSION_REQUIRED:'관리 링크를 다시 열어 주세요.',LINK_EXPIRED_OR_USED:'이미 사용했거나 만료된 링크입니다. 새 관리 링크를 열어 주세요.',INVALID_RESTAURANT_URL:'캐치테이블 매장 페이지 링크를 입력해 주세요.',RESTAURANT_ALREADY_EXISTS:'이미 목록에 있는 매장입니다.',RESTAURANT_HAS_ACTIVE_JOBS:'진행 중인 실행 요청을 먼저 취소해 주세요.',BOOKING_WINDOW_CONFLICT:'다른 예약 요청과 실행 시간이 겹칩니다. 10분 이상 간격을 두어 주세요.',BOOKING_ALREADY_EXISTS:'동일한 방문 일정이 이미 등록되어 있습니다.',INVALID_OPENING_TIME:'실행 시각은 현재 이후, 방문 시각 이전으로 지정해 주세요.',OPENING_TIME_PASSED:'실행 시각이 지났습니다. 새 요청을 등록해 주세요.',INVALID_DINING_TIME:'방문 날짜와 시간을 확인해 주세요.',INVALID_PARTY_SIZE:'예약 인원을 확인해 주세요.',RESTAURANT_PAUSED:'휴점 중인 매장은 예약 요청을 등록할 수 없습니다.',BOOKING_SCREEN_NOT_READY:'서버 예약 화면이 준비되면 열 수 있습니다.',BOOKING_STATE_CHANGED:'요청 상태가 바뀌었습니다. 목록을 새로 확인해 주세요.',BROWSER_BUSY:'서버 브라우저를 사용 중입니다. 잠시 후 다시 시도해 주세요.'};
async function api(path, body, method='POST') {
  const response = await fetch(path, body === undefined ? {} : {method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const result = await response.json();
  if (!response.ok) throw new Error(messages[result.error] ?? '요청을 처리하지 못했습니다. 입력 내용과 서버 연결을 확인해 주세요.');
  return result;
}
function notice(message) { $('notice').textContent=message; $('notice').hidden=false; clearTimeout(timer); timer=setTimeout(()=>{$('notice').hidden=true;},8000); }
const stateNames={DRAFT:'초안',SCHEDULED:'실행 대기',PREPARING:'화면 준비 중',NEEDS_LOGIN:'로그인 필요',READY:'직접 예약 진행',COMPLETED:'내역 확인 완료',CANCELLED:'실행 취소',EXPIRED:'시간 만료',FAILED:'확인 필요',INTERRUPTED:'중단 · 내역 확인 필요'};
function render() {
  const term=$('search').value.trim().toLowerCase();
  const restaurants=data.restaurants.filter(r=>`${r.name} ${r.chef} ${r.area}`.toLowerCase().includes(term));
  $('count').textContent=data.restaurants.length;
  $('restaurants').innerHTML=restaurants.map(r=>`<article class="card"><div class="card-top"><span class="tag ${r.status==='PAUSED'?'paused':''}">${r.status==='PAUSED'?'휴점 · 보류':'셰프의 식탁'}</span><button class="edit" data-edit="${esc(r.id)}" aria-label="${esc(r.name)} 수정">수정</button></div><h3>${esc(r.name)}</h3><p class="chef">${esc(r.chef)}</p><p class="area">${esc(r.area)}</p><p class="notes">${esc(r.notes)}</p><p class="opening">${esc(r.openingNotes || '예약 오픈 안내를 추가해 주세요.')}</p><div class="card-actions"><button data-book="${esc(r.id)}" ${r.status==='PAUSED'?'disabled':''}>예약 요청</button><a class="source" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">캐치테이블 ↗</a></div><span class="verified">${r.verifiedAt?'2026.11.02 캐치테이블 페이지 확인':'직접 등록 · 매장 정보 확인 필요'}</span></article>`).join('') || '<p class="empty">검색한 매장이 없습니다.</p>';
  $('jobs').innerHTML=data.jobs.map(j=>{const restaurant=data.restaurants.find(r=>r.id===j.restaurantId); return `<article class="job"><div><span class="badge ${['READY','NEEDS_LOGIN','FAILED','INTERRUPTED'].includes(j.state)?'warning':'neutral'}">${stateNames[j.state]??esc(j.state)}</span><h3>${esc(restaurant?.name)}</h3><p>방문 ${esc(j.diningDate)} ${esc(j.diningTime)} · ${j.partySize}명</p><p class="detail">예약 준비 ${esc(kst(j.opensAt))} · 접속 가능 시간 10분</p>${j.notify?`<p class="detail">Slack 알림 ${j.notification==="FAILED"?"실패 · 관리 화면에서 열어 주세요":j.notification==="SENT"?"전송 완료":"요청됨"}</p>`:""}${j.message?`<p class="detail">${esc(j.message)}</p>`:''}</div><div class="job-actions">${j.state==='DRAFT'?`<button data-arm="${j.id}">실행 등록</button>`:''}${['DRAFT','SCHEDULED','NEEDS_LOGIN'].includes(j.state)?`<button data-cancel="${j.id}">실행 취소</button>`:''}${['READY','NEEDS_LOGIN'].includes(j.state)?`<button class="primary" data-link="${j.id}">${j.state==='READY'?'서버 예약 화면':'로그인 화면'} 열기</button>`:''}</div></article>`;}).join('') || '<div class="empty">아직 예약 요청이 없습니다.<br>매장에서 ‘예약 요청’을 눌러 방문 일정과 실행 시각을 등록해 주세요.</div>';
}
async function refresh() {
  if(refreshing) return; refreshing=true;
  try { data=await api('/api/app'); $('gate').hidden=true; $('app').hidden=false; $('account').hidden=false; render(); }
  catch(error) { if(!data) $('gate-description').textContent=error.message; }
  finally {refreshing=false;}
}
async function enter() {
  $('join').disabled=true;
  try {await api('/api/console/exchange',{token}); token=undefined; await refresh();}
  catch(error){$('gate-description').textContent=error.message;}
  finally{$('join').disabled=false;}
}
$('join').onclick=enter;
if(token) $('join').hidden=false; else void refresh();
refreshTimer=setInterval(()=>{if(data) void refresh();},3000);
window.addEventListener('pagehide',()=>clearInterval(refreshTimer));
$('search').addEventListener('input',()=>{if(data) render();});
function editRestaurant(id) {
  const form=$('restaurant-form'); form.reset();form.querySelector('.form-error').textContent='';
  const r=id?data.restaurants.find(row=>row.id===id):{id:'',name:'',chef:'',area:'',url:'',notes:'',openingNotes:'',status:'OPEN',maxParty:4};
  for(const [key,value] of Object.entries(r)) if(form.elements.namedItem(key)) form.elements.namedItem(key).value=value??'';
  $('restaurant-form-title').textContent=id?'매장 수정':'매장 추가';$('restaurant-dialog').showModal();
}
$('add').onclick=()=>editRestaurant();
for(const button of document.querySelectorAll('[data-close]')) button.onclick=()=>button.closest('dialog').close();
$('restaurant-form').onsubmit=async event=>{
  event.preventDefault();const form=event.currentTarget;const body=Object.fromEntries(new FormData(form));
  event.submitter.disabled=true;
  try{await api(`/api/app/restaurants${body.id?'/'+encodeURIComponent(body.id):''}`,body,body.id?'PATCH':'POST');$('restaurant-dialog').close();await refresh();notice('매장을 저장했습니다.');}
  catch(error){form.querySelector('.form-error').textContent=error.message;}finally{event.submitter.disabled=false;}
};
function book(id) {
  const restaurant=data.restaurants.find(r=>r.id===id), form=$('booking-form');form.reset();form.querySelector('.form-error').textContent='';
  form.elements.restaurantId.value=id;form.elements.partySize.max=restaurant.maxParty;form.elements.partySize.value=Math.min(2,restaurant.maxParty);
  form.elements.diningDate.min=localKst(Date.now()).slice(0,10);form.elements.opensAt.value=localKst(Date.now()+5*60000);
  $('booking-title').textContent=restaurant.name; $('booking-notes').textContent=restaurant.notes;$('opening-notes').textContent=restaurant.openingNotes;
  $('booking-dialog').showModal();
}
$('booking-form').onsubmit=async event=>{
  event.preventDefault();const form=event.currentTarget;const body=Object.fromEntries(new FormData(form));body.opensAt += ':00+09:00';body.notify=form.elements.notify.checked;
  event.submitter.disabled=true; let saved;
  try{
    saved=(await api('/api/app/jobs',body)).job;
    if(event.submitter.value==='arm') await api(`/api/app/jobs/${saved.id}/arm`,{confirmed:true});
    $('booking-dialog').close();await refresh();notice(event.submitter.value==='arm'?'실행 시각을 등록했습니다. 최종 확정은 원격 화면에서 진행해 주세요.':'초안을 저장했습니다. 실행 등록 후 지정 시각에 동작합니다.');
  }catch(error){if(saved){$('booking-dialog').close();await refresh();notice(`초안은 저장됐습니다. ${error.message}`);}else form.querySelector('.form-error').textContent=error.message;}
  finally{event.submitter.disabled=false;}
};
$('app').onclick=async event=>{
  const button=event.target.closest('button');if(!button) return;
  if(button.dataset.edit) return editRestaurant(button.dataset.edit);
  if(button.dataset.book) return book(button.dataset.book);
  const action=['arm','cancel','link'].find(key=>button.dataset[key]);if(!action) return;
  if(action==='arm' && !confirm('지정 시각에 서버 예약 화면을 준비합니다. 최종 예약 확정은 직접 진행합니다. 실행 등록할까요?'))return;
  button.disabled=true;
  const tab=action==='link'?window.open('about:blank','_blank'):undefined;if(tab)tab.opener=null;
  try{const result=await api(`/api/app/jobs/${button.dataset[action]}/${action}`,{confirmed:true});if(result.url){if(tab)tab.location.replace(result.url);else location.assign(result.url);}else{await refresh();notice(action==='cancel'?'실행을 취소했습니다. 캐치테이블 예약 취소는 별도로 진행해 주세요.':'실행 시각을 등록했습니다.');}}
  catch(error){tab?.close();notice(error.message);}finally{button.disabled=false;}
};
$('account').onclick=async()=>{
  $('account').disabled=true;const tab=window.open('about:blank','_blank');if(tab)tab.opener=null;
  try{const result=await api('/api/auth/ensure',{notify:false});if(tab)tab.location.replace(result.loginUrl);else location.assign(result.loginUrl);}
  catch(error){tab?.close();notice(error.message);}finally{$('account').disabled=false;}
};
