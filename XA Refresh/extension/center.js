'use strict';
const $=id=>document.getElementById(id);
async function render(){
  const [{jobs},{events=[]}]=await Promise.all([chrome.runtime.sendMessage({type:'status'}),chrome.storage.local.get('events')]);
  $('jobs').replaceChildren();$('events').replaceChildren();$('stop').disabled=!Object.keys(jobs).length;
  for(const [id,job] of Object.entries(jobs)){
    const row=document.createElement('div'),name=document.createElement('span'),stop=document.createElement('button');row.className='job';
    name.textContent=job.title+' · '+job.count+' refreshed · '+(job.phase==='waiting'?'next at '+new Date(job.due).toLocaleTimeString():job.phase);
    stop.textContent='Stop';stop.onclick=()=>chrome.runtime.sendMessage({type:'stop',id:Number(id)});
    row.append(name,stop);$('jobs').append(row);
  }
  if(!Object.keys(jobs).length)$('jobs').textContent='No active timers.';
  for(const e of events){const row=document.createElement('div'),time=document.createElement('time');row.className='event';time.textContent=new Date(e.time).toLocaleString();row.append(time,e.title+' — '+e.message);$('events').append(row);}
  if(!events.length)$('events').textContent='No recent activity.';
}
$('stop').onclick=()=>chrome.runtime.sendMessage({type:'stopAll'});
chrome.storage.onChanged.addListener(render);render();
