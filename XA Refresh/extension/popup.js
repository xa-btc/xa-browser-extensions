'use strict';
const $=id=>document.getElementById(id),form=$('config'),fields=form.elements;
let tab,job,error='';
const send=(type,config)=>chrome.runtime.sendMessage({type,id:tab.id,config});
function display(){
  $('range').hidden=fields.mode.value!=='random';$('watch').hidden=fields.monitor.value==='off';
  $('term').hidden=!['contains','absent'].includes(fields.monitor.value);
  $('stop').hidden=!job;$('start').textContent=job?'Update timer':'Start refreshing';
  $('status').textContent=error||(job?(job.phase==='waiting'?'Next refresh in '+Math.max(0,Math.ceil((job.due-Date.now())/1000))+'s':job.phase==='loading'?'Loading page':'Checking page')+' · '+job.count+' refreshed':'');
}
function read(){
  const c={};
  for(const f of fields)if(f.name)c[f.name]=f.type==='checkbox'?f.checked:f.type==='number'?Number(f.value):f.value;
  return c;
}
async function init(){
  [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  $('site').textContent=tab?.title||'Current tab';
  if(!/^https?:\/\//i.test(tab?.url||'')){error='Open XR on an HTTP or HTTPS page.';$('start').disabled=true;display();return;}
  const {last}=await chrome.storage.local.get('last');
  job=(await send('status')).jobs[tab.id];
  for(const [key,value] of Object.entries(job?.config||last||{})){
    const f=fields.namedItem(key);if(!f)continue;
    if(f.type==='checkbox')f.checked=value;else f.value=value;
  }
  display();
}
form.onchange=display;
$('presets').onclick=e=>{if(e.target.tagName==='BUTTON')fields.seconds.value=parseInt(e.target.textContent)*(e.target.textContent.endsWith('m')?60:1);};
form.onsubmit=async e=>{
  e.preventDefault();error='';const c=read();
  try{
    if(c.monitor!=='off'){
      const url=new URL(tab.url);
      if(!await chrome.permissions.request({origins:[url.protocol+'//'+url.hostname+'/*']}))throw Error('Site access is needed to check this page after reloading.');
    }
    const result=await send('start',c);if(result.error)throw Error(result.error);
    job=result.jobs[tab.id];await chrome.storage.local.set({last:{...c,at:''}});
  }catch(e){error=e.message;}
  display();
};
$('stop').onclick=async()=>{const result=await send('stop');job=result.jobs[tab.id];error='';display();};
$('center').onclick=()=>chrome.runtime.openOptionsPage();
chrome.storage.onChanged.addListener((changes,area)=>{if(tab&&area==='session'&&changes.jobs){job=changes.jobs.newValue?.[tab.id];display();}});
setInterval(display,500);init().catch(e=>{error=e.message;display();});
