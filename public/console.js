import {createCatchtablePanel, messages as bookingMessages} from './app.js';
import {createWaitingPanel, messages as waitingMessages} from './waiting.js';

const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const messages={...bookingMessages,...waitingMessages};
let token=new URLSearchParams(location.hash.slice(1)).get('token'),catalog,active,timer;
history.replaceState(null,'',location.pathname);
async function api(path,body,method='POST') {
  const response=await fetch(path,body===undefined?{}:{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok){const error=new Error(messages[result.error]??'요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');error.status=response.status;error.code=result.error;throw error;}
  return result;
}
function notice(message){$('notice').textContent=message;$('notice').hidden=false;clearTimeout(timer);timer=setTimeout(()=>{$('notice').hidden=true;},8000);}
const panels={waiting:createWaitingPanel({api,notice}),catchtable:createCatchtablePanel({api,notice,onRestaurantsChanged:id=>enter(`catchtable:${id}`)})};
const key=restaurant=>`${restaurant.kind}:${restaurant.id}`;
async function select(restaurant){
  active=restaurant;
  for(const tab of $('restaurant-tabs').querySelectorAll('[role=tab]')){const selected=tab.dataset.key===key(active);tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;}
  for(const kind of ['waiting','catchtable'])$(kind+'-panel').hidden=active.kind!==kind;
  const selected=$('restaurant-tabs').querySelector('[aria-selected=true]');
  $(active.kind+'-panel').setAttribute('aria-labelledby',selected.id);
  $('account').hidden=active.kind!=='catchtable';
  await panels[active.kind].select(active.id);
}
async function enter(preferred){
  const next=await api('/api/app/console');
  catalog=next;$('gate').hidden=true;$('console').hidden=false;$('add').hidden=!next.canAddRestaurant;
  $('restaurant-tabs').innerHTML=next.restaurants.map((restaurant,index)=>`<button role="tab" id="restaurant-tab-${index}" data-key="${esc(key(restaurant))}" aria-controls="${restaurant.kind}-panel" aria-selected="false" tabindex="-1">${esc(restaurant.name)}</button>`).join('');
  $('no-restaurants').hidden=next.restaurants.length>0;
  const preferredKey=preferred??(active&&key(active));
  const selected=next.restaurants.find(restaurant=>key(restaurant)===preferredKey)??next.restaurants[0];
  if(selected)await select(selected);
}
function failed(error){if(!catalog||error.status===401){$('gate').hidden=false;$('console').hidden=true;$('account').hidden=true;$('gate-description').textContent=error.message;}else notice(error.message);}
$('restaurant-tabs').onclick=event=>{const tab=event.target.closest('[role=tab]');if(!tab)return;const restaurant=catalog.restaurants.find(restaurant=>key(restaurant)===tab.dataset.key);if(restaurant)void select(restaurant).catch(failed);};
$('restaurant-tabs').onkeydown=event=>{
  const tabs=Array.from($('restaurant-tabs').querySelectorAll('[role=tab]')),index=tabs.indexOf(document.activeElement);
  if(index<0||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
  tabs[next].focus();tabs[next].click();
};
$('join').onclick=async()=>{ $('join').disabled=true;try{await api('/api/console/exchange',{token});token=undefined;await enter();}catch(error){failed(error);}finally{$('join').disabled=false;} };
if(token)$('join').hidden=false;else void enter().catch(failed);
window.addEventListener('hashchange',()=>{const incoming=new URLSearchParams(location.hash.slice(1)).get('token');if(!incoming)return;history.replaceState(null,'',location.pathname);token=incoming;catalog=undefined;active=undefined;$('gate').hidden=false;$('console').hidden=true;$('account').hidden=true;$('join').hidden=false;});
const poll=setInterval(()=>{if(active&&!$('console').hidden)void panels[active.kind].refresh().catch(failed);},10000);
window.addEventListener('pagehide',()=>clearInterval(poll));
