'use strict';
(()=>{
  let mode,lastHeight=-1,state={ladder:[],width:0,height:0};
  function apply(){if(mode)document.dispatchEvent(new CustomEvent('xa-paramount-mode',{detail:mode}));}
  document.addEventListener('xa-paramount-ready',apply);
  document.addEventListener('xa-paramount-status',e=>{
    try{
      const v=JSON.parse(e.detail),safe=n=>Number.isSafeInteger(n)&&n>=0&&n<32768?n:0;
      if(!Array.isArray(v.ladder))return;
      state={width:safe(v.width),height:safe(v.height),ladder:v.ladder.slice(0,64).filter(Array.isArray).map(([h,b])=>[safe(h),Number.isSafeInteger(b)&&b>=0?b:0]).filter(([h])=>h)};
      if(state.height!==lastHeight){lastHeight=state.height;chrome.runtime.sendMessage({height:state.height}).catch(()=>{});}
    }catch{}
  });
  chrome.storage.local.get({mode:'auto'}).then(r=>{mode=r.mode;apply();});
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.mode){mode=changes.mode.newValue||'auto';apply();}});
  chrome.runtime.onMessage.addListener((m,s,reply)=>{if(m.op==='status'){document.dispatchEvent(new Event('xa-paramount-read'));reply(state);}});
  document.addEventListener('emptied',()=>document.dispatchEvent(new Event('xa-paramount-read')),true);
})();
