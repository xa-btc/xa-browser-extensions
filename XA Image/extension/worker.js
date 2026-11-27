'use strict';
importScripts('providers.js');
const ROOT='xi-image',jobKey=id=>'xi-'+id;
chrome.runtime.onInstalled.addListener(()=>{
  chrome.contextMenus.removeAll(()=>{
    const contexts=['image','link'];
    chrome.contextMenus.create({id:ROOT,title:'XA Image',contexts});
    for(const [id,title] of Object.entries(providers))chrome.contextMenus.create({id,title,parentId:ROOT,contexts});
    chrome.contextMenus.create({id:'upload',title:'Upload displayed image…',parentId:ROOT,contexts:['image']});
  });
});
async function stage(tab,job){
  await chrome.storage.session.set({[jobKey(tab.id)]:{...job,created:Date.now()}});
}
async function chosen(info,tab){
  const provider=String(info.menuItemId);
  if(provider!=='upload'&&!Object.hasOwn(providers,provider))return;
  const source=provider==='upload'?info.srcUrl:original(info);
  if(!source)return;
  const output=await chrome.tabs.create({url:'about:blank',index:tab.index+1,openerTabId:tab.id});
  try{
    const url=webUrl(source);
    if(!needsUpload(url)&&provider!=='upload'){
      if(provider==='google'||provider==='baidu')await stage(output,{provider,source:url});
      await chrome.tabs.update(output.id,{url:destination(provider,url)});return;
    }
    // Retrieve the exact selected image while the invoking tab still has activeTab access.
    let data='';
    if(/^data:image\//i.test(source))data=source;
    else{
      const [{result}]=await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[info.frameId||0]},args:[source],func:async src=>{
        const img=[...document.images].find(i=>i.currentSrc===src||i.src===src);
        function pixels(){
          if(!img?.naturalWidth)throw Error('Image pixels unavailable.');
          const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
          canvas.getContext('2d').drawImage(img,0,0);return canvas.toDataURL('image/png');
        }
        try{
          const resp=await fetch(src,{credentials:'same-origin'});if(!resp.ok)throw Error();
          const blob=await resp.blob();if(!blob.type.startsWith('image/'))return pixels();
          return await new Promise((ok,fail)=>{const r=new FileReader();r.onload=()=>ok(r.result);r.onerror=fail;r.readAsDataURL(blob);});
        }catch{try{return pixels();}catch{return '';}}
      }});
      data=result;
    }
    if(!data)throw Error('Brave could not read this image. Choose a saved copy to upload.');
    await stage(output,{provider,data});
    await chrome.tabs.update(output.id,{url:chrome.runtime.getURL('search.html')});
  }catch(e){
    await stage(output,{provider,error:'Could not prepare this image. Choose a saved copy below. '+e.message});
    await chrome.tabs.update(output.id,{url:chrome.runtime.getURL('search.html')});
  }
}
chrome.contextMenus.onClicked.addListener((info,tab)=>chosen(info,tab).catch(console.error));
chrome.tabs.onRemoved.addListener(id=>chrome.storage.session.remove(jobKey(id)));
chrome.runtime.onMessage.addListener((m,s,reply)=>{
  if(s.id!==chrome.runtime.id||!s.tab)return;
  const id=s.tab.id,key=jobKey(id),own=s.url?.startsWith(chrome.runtime.getURL(''));
  (async()=>{
    const job=(await chrome.storage.session.get(key))[key];
    if(own&&m.op==='stage'){
      if(!Object.hasOwn(providers,m.job?.provider))throw Error('Unknown provider');
      await stage(s.tab,m.job);return {};
    }
    if(own&&m.op==='clear'){await chrome.storage.session.remove(key);return {};}
    if(own&&m.op==='get')return job||{};
    const u=new URL(s.url);
    const hosts={google:'www.google.com',baidu:'graph.baidu.com',yandex:'yandex.com'};
    if(job&&Date.now()-job.created>30*60*1000){await chrome.storage.session.remove(key);return {};}
    if(!job||u.protocol!=='https:'||hosts[job.provider]!==u.hostname||s.frameId!==0)return {};
    if(m.op==='done'){await chrome.storage.session.remove(key);return {};}
    if(m.op==='provider')return job.provider==='google'?{provider:'google'}:job;
    return {};
  })().then(reply,e=>reply({error:e.message}));return true;
});

chrome.action.onClicked.addListener(()=>chrome.tabs.create({url:chrome.runtime.getURL('search.html')}));
