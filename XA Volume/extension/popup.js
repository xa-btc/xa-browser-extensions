'use strict';
const $=id=>document.getElementById(id);
let id,prefs,state={volume:100,muted:false},version=0;
function render(){
  $('volume').value=state.volume;$('level').value=Math.round(sliderPosition(state.volume));
  $('mute').setAttribute('aria-pressed',String(state.muted));$('mute').textContent=state.muted?'Unmute':'Mute';
}
async function action(op,value){
  const request=++version;
  try{
    const result=await chrome.runtime.sendMessage({to:'worker',id,op,value});
    if(request!==version)return;
    if(result.error)throw Error(result.error);
    state=result.state;$('status').textContent='';
  }catch(e){
    if(request!==version)return;
    $('status').textContent=e.message;
    const actual=await chrome.runtime.sendMessage({to:'worker',op:'state'}).catch(()=>null);
    if(request===version)state=actual?.states?.[id]||{volume:100,muted:false};
  }
  if(request===version)render();
}
async function list(){
  const tabs=await chrome.tabs.query({audible:true});
  const others=tabs.filter(t=>t.id!==id);
  $('others').hidden=!others.length;$('tabs').replaceChildren();
  for(const t of others){
    const li=document.createElement('li'),b=document.createElement('button');
    b.textContent=t.title||'Audio tab';b.onclick=async()=>{await chrome.windows.update(t.windowId,{focused:true});await chrome.tabs.update(t.id,{active:true});window.close();};
    li.append(b);$('tabs').append(li);
  }
}
async function init(){
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});id=tab.id;
  prefs=await settings();document.documentElement.classList.toggle('dark',prefs.dark);
  $('site').textContent=tab.title;$('tip').hidden=prefs.hideTips;
  $('level').max=Math.ceil(sliderPosition(prefs.max));$('volume').max=prefs.max;
  const reply=await chrome.runtime.sendMessage({to:'worker',op:'state'});if(reply.error)throw Error(reply.error);
  state=reply.states[id]||state;render();
  $('level').oninput=()=>{const value=Math.min(prefs.max,sliderValue(Number($('level').value)));state={volume:value,muted:false};$('volume').value=value;action('set',value);};
  $('volume').onchange=()=>{if($('volume').value===''){render();return;}action('set',Number($('volume').value));};
  $('mute').onclick=()=>action('mute');$('reset').onclick=()=>action('reset');
  addEventListener('wheel',e=>{
    e.preventDefault();if(!e.deltaY)return;
    const value=Math.max(0,Math.min(prefs.max,stepVolume(state.volume,-Math.sign(e.deltaY),e.ctrlKey)));
    state={volume:value,muted:false};render();action('set',value);
  },{passive:false});
  chrome.runtime.onMessage.addListener(m=>{
    if(m.to==='popup'&&m.id===id){state=m.state;render();}
  });
  await list();chrome.tabs.onUpdated.addListener((_,change)=>{if('audible' in change||'title' in change)list();});
}
$('settings').onclick=()=>chrome.runtime.openOptionsPage();
init().catch(e=>{$('status').textContent=e.message;});
