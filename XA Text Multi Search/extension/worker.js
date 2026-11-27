importScripts('model.js');
const frames = new Map();
let writes = Promise.resolve();
const serial = task => { const next=writes.then(task); writes=next.catch(()=>{}); return next; };
const tabKey = id => 'tab-'+id;
async function model() {
  const {settings,rows=[]}=await chrome.storage.local.get(['settings','rows']);
  return {prefs:{...XT.defaults,...settings},rows};
}
async function tabState(id) {
  return (await chrome.storage.session.get(tabKey(id)))[tabKey(id)] || {open:false};
}
function send(port,data) { try {port.postMessage(data);} catch {} }
function broadcast(id,data) {
  for(const frame of frames.get(id)?.values() || []) send(frame.port,data);
}
async function show(id,value) {
  const state=await tabState(id);
  state.open=value??!state.open;
  await chrome.storage.session.set({[tabKey(id)]:state});
  broadcast(id,{type:'panel',open:state.open});
}
async function menu() {
  const {prefs}=await model();
  await chrome.contextMenus.removeAll();
  if(prefs.context==='none')return;
  chrome.contextMenus.create({id:'add',title:'Add selection to XA Text Multi Search',contexts:['selection']});
  if(prefs.context==='advanced') chrome.contextMenus.create({id:'similar',title:'Add text from matching page elements',contexts:['selection']});
}
chrome.runtime.onInstalled.addListener(menu);
async function commit(rows) {
  const {rows:old=[],undo=[],redo=[]}=await chrome.storage.local.get(['rows','undo','redo']);
  const normalized=XT.terms(rows);
  if(JSON.stringify(normalized)===JSON.stringify(old)) return;
  await chrome.storage.local.set({rows:normalized,undo:[...undo,old].slice(-32),redo:[]});
}
async function historyMove(direction) {
  const {rows=[],undo=[],redo=[]}=await chrome.storage.local.get(['rows','undo','redo']);
  const source=direction==='undo'?undo:redo, destination=direction==='undo'?redo:undo;
  if(!source.length)return;
  destination.push(rows);
  await chrome.storage.local.set({rows:source.pop(),undo,redo});
}
async function append(values) {
  const {rows}=await model();
  const existing=new Set(rows.map(r=>r.text));
  const added=values.filter(text=>text && !existing.has(text) && existing.add(text));
  await commit([...rows,...added.map((text,i)=>({text,slot:rows.length+i}))]);
}
function ordered(id) {return [...(frames.get(id)?.entries()||[])].sort(([a],[b])=>a-b);}
async function totals(id) {
  const list=ordered(id);
  const counts=[];
  for(const [,frame] of list) for(const [i,n] of (frame.counts||[]).entries()) counts[i]=(counts[i]||0)+n;
  const total=counts.reduce((a,b)=>a+b,0);
  const top=frames.get(id)?.get(0);
  if(top)send(top.port,{type:'counts',counts,total});
  const before=previousCounts.get(id) || 0;
  previousCounts.set(id,total);
  const {prefs}=await model();
  if(top && total>before && prefs.sound!=='off')send(top.port,{type:'tone'});
  await chrome.action.setBadgeText({tabId:id,text:prefs.badge==='off'||(!total&&prefs.badge!=='always')?'':String(total)}).catch(()=>{});
}
const cursors=new Map();
const previousCounts=new Map();
function navigate(id,row,step) {
  const key=row??-1;
  const list=ordered(id).map(([frameId,frame])=>({frameId,frame,n:key===-1?(frame.counts||[]).reduce((a,b)=>a+b,0):(frame.counts?.[key]||0)}));
  const total=list.reduce((sum,item)=>sum+item.n,0);
  if(!total) return;
  const previous=cursors.get(id);
  let index=((previous?.key===key?previous.index:step>0?-1:0)+step+total)%total;
  const globalIndex=index;
  for(const item of list) {
    if(index<item.n) {
      broadcast(id,{type:'unfocus'});
      send(item.frame.port,{type:'jump',row:key,index});
      cursors.set(id,{key,index:globalIndex});
      break;
    }
    index-=item.n;
  }
}
async function command(id,name) {
  if(name==='panel')return show(id);
  if(name==='next'||name==='prev')return navigate(id,-1,name==='next'?1:-1);
  if(name==='flash'||name==='add'){broadcast(id,{type:name});return;}
  if(name==='clear')return commit([]);
  const {prefs}=await model();
  const updates={case:['caseSensitive',!prefs.caseSensitive],accents:['accents',!prefs.accents],marks:['marks',!prefs.marks],
    sound:['sound',prefs.sound==='off'?'chime':'off'],style:['style',({solid:'glow',glow:'none',none:'solid'})[prefs.style]],
    highlights:['visibility',prefs.visibility==='never'?'always':'never']};
  const pair=updates[name];
  if(pair) await chrome.storage.local.set({settings:{...prefs,[pair[0]]:pair[1]}});
}
async function activate(tab) {
  if(!tab?.id)return;
  try {
    await chrome.tabs.sendMessage(tab.id,{type:'wake'},{frameId:0});
    await serial(()=>show(tab.id));
  } catch {await chrome.tabs.create({url:chrome.runtime.getURL('settings.html#unavailable')});}
}
chrome.action.onClicked.addListener(activate);
chrome.commands.onCommand.addListener((name,tab)=>{if(tab?.id)serial(()=>command(tab.id,name));});
chrome.contextMenus.onClicked.addListener((info,tab)=>{
  if(!tab?.id)return;
  serial(async()=>{
    if(info.menuItemId==='similar') {
      const frame=frames.get(tab.id)?.get(info.frameId??0);
      if(frame)send(frame.port,{type:'similar',text:info.selectionText});
      else await append([info.selectionText]);
    } else await append([info.selectionText]);
    await show(tab.id,true);
  });
});
chrome.tabs.onRemoved.addListener(id=>{frames.delete(id);cursors.delete(id);previousCounts.delete(id);chrome.storage.session.remove(tabKey(id));});
chrome.runtime.onConnect.addListener(port=>{
  const id=port.sender.tab?.id,frameId=port.sender.frameId;
  if(port.name!=='xt-page'||id==null)return;
  if(!frames.has(id))frames.set(id,new Map());
  const group=frames.get(id), frame={port,counts:[],url:port.sender.url};
  group.set(frameId,frame);
  Promise.all([model(),tabState(id)]).then(([data,state])=>{
    const top=group.get(0);
    chrome.commands.getAll().then(commands=>send(port,{type:'shortcuts',keys:Object.fromEntries(commands.map(c=>[c.name,c.shortcut]))}));
    send(port,{type:'init',...data,...state,parentBlocked:frameId!==0 && (!top || !XT.allowed(top.url,data.prefs))});
    if(frameId===0)broadcast(id,{type:'site',blocked:!XT.allowed(frame.url,data.prefs)});
  });
  port.onDisconnect.addListener(()=>{
    if(group.get(frameId)!==frame)return;
    group.delete(frameId);if(!group.size)frames.delete(id);
    totals(id).catch(()=>{});
  });
  port.onMessage.addListener(msg=>{
    if(msg.type==='location' && frameId===0){
      frame.url=msg.url;
      model().then(({prefs})=>broadcast(id,{type:'site',blocked:!XT.allowed(frame.url,prefs)}));
      return;
    }
    if(msg.type==='counts'){frame.counts=msg.counts;totals(id).catch(()=>{});return;}
    if(msg.type==='navigate'){navigate(id,msg.row,msg.step);return;}
    if(msg.type==='flash'){broadcast(id,{type:'flash'});return;}
    serial(async()=>{
      switch(msg.type) {
        case 'list':await commit(msg.rows);send(port,{type:'listSaved',revision:msg.revision});break;
        case 'append':await append(msg.values);break;
        case 'panel':await show(id,msg.open);break;
        case 'undo': case 'redo':await historyMove(msg.type);break;
        case 'settings':await chrome.runtime.openOptionsPage();break;
        case 'prefs':{const {prefs}=await model();await chrome.storage.local.set({settings:{...prefs,...msg.patch}});break;}
      }
    }).catch(error=>send(port,{type:'error',text:error.message}));
  });
});
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area!=='local'||(!changes.rows&&!changes.settings))return;
  if(changes.settings?.newValue?.context!==changes.settings?.oldValue?.context)menu().catch(()=>{});
  model().then(data=>{for(const id of frames.keys()){cursors.delete(id);
    const top=frames.get(id)?.get(0);
    broadcast(id,{type:'model',...data,parentBlocked:!top || !XT.allowed(top.url,data.prefs)});}});
});

