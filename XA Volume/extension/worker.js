'use strict';
importScripts('model.js');
let chain=Promise.resolve();
function serial(fn){const next=chain.then(fn);chain=next.catch(()=>{});return next;}
async function hasAudio(){
  return (await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})).length>0;
}
async function audio(op,fields={}){
  const result=await chrome.runtime.sendMessage({to:'audio',op,...fields});
  if(result?.error)throw Error(result.error);
  if(!result?.states)throw Error('The audio controller did not respond.');
  return result.states;
}
async function states(){return await hasAudio()?audio('state'):{};}
async function badge(id,state){
  const text=state?(state.muted?'M':String(state.volume)):'';
  await chrome.action.setBadgeText({tabId:id,text}).catch(()=>{});
}
async function cleanup(id){
  if(await hasAudio()){
    const left=await audio('release',{id});
    if(!Object.keys(left).length)await chrome.offscreen.closeDocument();
  }
  await badge(id,null);
}
async function update(id,op,value){
  if(!Number.isInteger(id))throw Error('Select a browser tab.');
  const all=await states(),current=all[id]||{volume:100,muted:false};
  const prefs=await settings();
  let volume=current.volume,muted=current.muted;
  if(op==='mute')muted=!muted;
  else if(op!=='reset'){
    const desired=op==='set'?value:stepVolume(volume,op==='up'?1:-1);
    if(!Number.isFinite(desired))throw Error('Enter a volume percentage.');
    volume=Math.min(prefs.max,Math.max(0,Math.round(desired)));muted=false;
  }
  if(op==='reset'||(!muted&&volume===100)){await cleanup(id);return {volume:100,muted:false};}
  try{
    let token;
    if(!all[id]){
      token=await chrome.tabCapture.getMediaStreamId({targetTabId:id});
      if(!await hasAudio())await chrome.offscreen.createDocument({url:'audio.html',reasons:['USER_MEDIA'],justification:'Play the selected tab through its local volume control.'});
    }
    const next=await audio('apply',{id,token,volume,muted});
    await badge(id,next[id]);return next[id];
  }catch(e){
    if(await hasAudio()&&!Object.keys(await audio('state')).length)await chrome.offscreen.closeDocument();
    throw e;
  }
}
chrome.runtime.onMessage.addListener((m,s,reply)=>{
  if(m.to!=='worker'||s.id!==chrome.runtime.id||!s.url?.startsWith(chrome.runtime.getURL('')))return;
  serial(async()=>{
    if(m.op==='state')return {states:await states()};
    if(m.op==='ended'){const all=await states();if(!all[m.id])await cleanup(m.id);return {};}
    if(!['set','mute','reset','up','down'].includes(m.op))throw Error('Unknown volume control.');
    return {state:await update(m.id,m.op,m.value)};
  }).then(reply,e=>reply({error:e.message}));return true;
});
chrome.commands.onCommand.addListener((command,tab)=>{
  if(tab?.id)serial(async()=>{
    const state=await update(tab.id,command);
    await chrome.runtime.sendMessage({to:'popup',id:tab.id,state}).catch(()=>{});
  }).catch(console.warn);
});
chrome.tabs.onRemoved.addListener(id=>serial(async()=>{if((await states())[id])await cleanup(id);}).catch(console.warn));
chrome.webNavigation.onCommitted.addListener(e=>{
  if(e.frameId===0)serial(async()=>{if((await settings()).resetOnNavigation&&(await states())[e.tabId])await cleanup(e.tabId);}).catch(console.warn);
});
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='local'&&changes.max)serial(async()=>{
    for(const [id,s] of Object.entries(await states()))if(s.volume>changes.max.newValue){
      const next=await audio('apply',{id:Number(id),volume:changes.max.newValue,muted:s.muted});
      await badge(Number(id),next[id]);
    }
  }).catch(console.warn);
});
