'use strict';
const jobs=new Map(), timers=new Map();
let queue=chrome.storage.session.get('jobs').then(({jobs:saved={}})=>{
  for(const [id,job] of Object.entries(saved))jobs.set(+id,job);
});
function run(work){const result=queue.then(work);queue=result.catch(console.error);return result;}
const save=()=>chrome.storage.session.set({jobs:Object.fromEntries(jobs)});
function interval(c){return 1000*(c.seconds+(c.mode==='random'?Math.floor(Math.random()*(1+c.max-c.seconds)):0));}
async function schedule(id,job,when){
  clearTimeout(timers.get(id));job.due=when;await save();
  await chrome.alarms.create('xr-'+id,{when:Math.max(Date.now()+1,when)});
  const wait=when-Date.now();
  if(wait<30000)timers.set(id,setTimeout(()=>run(()=>tick(id)),Math.max(0,wait)));
}
async function end(id,message){
  const job=jobs.get(id);
  clearTimeout(timers.get(id));timers.delete(id);jobs.delete(id);
  await chrome.alarms.clear('xr-'+id);await save();
  await chrome.action.setBadgeText({tabId:id,text:''}).catch(()=>{});
  if(message&&job)await record(job,message);
}
async function record(job,message){
  const {events=[]}=await chrome.storage.local.get('events');
  await chrome.storage.local.set({events:[{time:Date.now(),title:job.title,message},...events].slice(0,100)});
}
async function sample(id,job){
  const [{result}]=await chrome.scripting.executeScript({target:{tabId:id},args:[job.config,job.origin],func:(c,origin)=>{
    if(location.origin!==origin)return {error:'The tab changed sites.'};
    try{
      const nodes=c.selector?[...document.querySelectorAll(c.selector)]:[document.body].filter(Boolean);
      if(c.monitor==='appears'||c.monitor==='disappears')return {value:(nodes.length>0)===(c.monitor==='appears')};
      const text=nodes.map(n=>n.innerText??n.textContent).join('\n');
      if(c.monitor==='change'){
        let hash=2166136261;for(let i=0;i<text.length;i++)hash=Math.imul(hash^text.charCodeAt(i),16777619);
        return {value:text.length+'/'+hash};
      }
      const found=c.sensitive?text.includes(c.keyword):text.toLowerCase().includes(c.keyword.toLowerCase());
      return {value:c.monitor==='contains'?found:!found};
    }catch{return {error:'Invalid CSS selector.'};}
  }});
  if(!result||result.error)throw Error(result?.error||'Page could not be read.');
  return result.value;
}
async function start(id,c){
  const tab=await chrome.tabs.get(id);
  if(!/^https?:\/\//i.test(tab.url||''))throw Error('Open a web page to start refreshing.');
  for(const key of ['seconds','max','limit','delay']){
    if(!Number.isSafeInteger(c[key])||c[key]<(key==='seconds'||key==='max'?1:0)||c[key]>2147483)throw Error('Invalid '+key);
  }
  if(c.mode==='random'&&c.max<c.seconds)throw Error('Maximum must be at least the minimum interval.');
  if(['contains','absent'].includes(c.monitor)&&!c.keyword.trim())throw Error('Enter the text to watch.');
  if(['appears','disappears'].includes(c.monitor)&&!c.selector.trim())throw Error('Enter a CSS selector.');
  if(c.at&&!(Date.parse(c.at)>Date.now()))throw Error('Choose a future first refresh.');
  const job={config:c,origin:new URL(tab.url).origin,count:0,phase:'waiting',title:tab.title};
  if(c.monitor!=='off')job.baseline=await sample(id,job);
  jobs.set(id,job);await schedule(id,job,c.at?Date.parse(c.at):Date.now()+interval(c));
  await chrome.action.setBadgeText({tabId:id,text:'ON'});
}
async function loaded(id){
  const job=jobs.get(id);if(job?.phase!=='loading')return;
  job.phase='scan';await schedule(id,job,Date.now()+job.config.delay*1000);
}
async function tick(id){
  const job=jobs.get(id);if(!job||job.due>Date.now()+10)return;
  try{
    const tab=await chrome.tabs.get(id),c=job.config;
    if(new URL(tab.pendingUrl||tab.url).origin!==job.origin)return await end(id,'Stopped after a site change.');
    if(job.phase==='loading'){
      if(tab.status==='complete')return await loaded(id);
      return await end(id,'Page load timed out.');
    }
    if(job.phase==='scan'){
      if(c.monitor!=='off'){
        const value=await sample(id,job);
        const hit=c.monitor==='change'?value!==job.baseline:value;
        job.baseline=value;
        if(hit){
          const message=c.monitor==='change'?'Page content changed.':'Monitor condition matched.';
          await record(job,message);
          if(c.notify)await chrome.notifications.create({type:'basic',iconUrl:'icons/128.png',title:'XA Refresh',message:job.title+' — '+message}).catch(()=>{});
          if(c.focus){await chrome.tabs.update(id,{active:true});await chrome.windows.update(tab.windowId,{focused:true});}
          if(!c.keep)return await end(id);
        }
      }
      if(c.mode==='once'||(c.limit&&job.count>=c.limit))return await end(id,'Refresh schedule completed.');
      job.phase='waiting';return await schedule(id,job,Date.now()+interval(c));
    }
    if(c.background&&tab.active)return await schedule(id,job,Date.now()+interval(c));
    job.phase='loading';job.count++;
    await schedule(id,job,Date.now()+120000);
    await chrome.tabs.reload(id,{bypassCache:c.hard});
  }catch(e){await end(id,e.message);}
}
chrome.alarms.onAlarm.addListener(a=>{if(a.name.startsWith('xr-'))run(()=>tick(Number(a.name.slice(3))));});
chrome.tabs.onUpdated.addListener((id,change)=>run(async()=>{
  const job=jobs.get(id);if(!job)return;
  if(change.url&&new URL(change.url).origin!==job.origin)return end(id,'Stopped after a site change.');
  if(change.status==='complete')await loaded(id);
}));
chrome.tabs.onRemoved.addListener(id=>run(()=>jobs.has(id)&&end(id)));
chrome.runtime.onMessage.addListener((m,s,reply)=>{
  if(s.id!==chrome.runtime.id||!s.url?.startsWith(chrome.runtime.getURL('')))return;
  run(async()=>{
    if(m.type==='start')await start(m.id,m.config);
    if(m.type==='stop')await end(m.id);
    if(m.type==='stopAll')for(const id of [...jobs.keys()])await end(id);
    return {jobs:Object.fromEntries(jobs)};
  }).then(reply,e=>reply({error:e.message}));return true;
});
run(async()=>{for(const [id,job] of jobs)await schedule(id,job,job.due);});

async function toggleTab(tab){
  if(!tab?.id||!/^https?:\/\//i.test(tab.url||''))return;
  if(jobs.has(tab.id))return end(tab.id);
  await start(tab.id,{mode:'fixed',seconds:60,max:60,limit:0,delay:0,monitor:'off',hard:false});
}
chrome.runtime.onInstalled.addListener(()=>chrome.contextMenus.create({
  id:'toggle',title:'Start / stop XA Refresh',contexts:['page'],documentUrlPatterns:['http://*/*','https://*/*']
}));
chrome.contextMenus.onClicked.addListener((info,tab)=>{if(info.menuItemId==='toggle')run(()=>toggleTab(tab));});
chrome.commands.onCommand.addListener((name,tab)=>{if(name==='toggle')run(()=>toggleTab(tab));});
