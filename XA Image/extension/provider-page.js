'use strict';
(async()=>{
  const request=op=>chrome.runtime.sendMessage({op});
  const job=await request('provider');
  if(!job?.provider)return;
  function notice(message){
    const box=document.createElement('div');
    box.style.cssText='position:fixed;top:12px;right:12px;z-index:2147483647;max-width:360px;padding:12px;background:#152238;color:white;font:14px system-ui;border-radius:6px';
    const close=document.createElement('button');close.textContent='Dismiss';close.onclick=()=>box.remove();
    box.append(message,' ',close);document.documentElement.append(box);
  }
  const waitFor=(find,ms=15000)=>new Promise(resolve=>{
    let observer,timer;
    function check(){const value=find();if(value){observer?.disconnect();clearTimeout(timer);resolve(value);return true;}}
    if(check())return;
    observer=new MutationObserver(check);observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true});
    timer=setTimeout(()=>{observer.disconnect();resolve(null);},ms);
  });
  if(job.provider==='google'){
    const params=new URLSearchParams(location.search);
    if(!['vsrid','gsessionid','vsint','lsessionid'].some(k=>params.has(k)))return;
    const exact=await waitFor(()=>[...document.querySelectorAll('a,button,[role="tab"],[role="link"],[role="button"]')].find(el=>
      el.getClientRects().length&&[el.textContent,el.getAttribute('aria-label')].some(s=>s?.trim().toLowerCase()==='exact matches')));
    await request('done');
    if(exact){
      if(exact.getAttribute('aria-selected')!=='true'&&exact.getAttribute('aria-current')!=='page')exact.click();
    }else notice('XI: Google did not offer an Exact matches control for this result.');
    return;
  }
  if(job.provider==='baidu'&&job.source){
    const field=await waitFor(()=>document.querySelector('input.graph-d20-search-wrapper-input,input[placeholder*="图片网址"]'));
    if(field){
      field.value=job.source;field.dispatchEvent(new Event('input',{bubbles:true}));
      await request('done');
      const submit=document.querySelector('.graph-d20-search-btn');
      if(submit)submit.click();else field.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13,bubbles:true}));
    }else{await request('done');notice('XI: Paste the image address into Baidu’s image search field. '+job.source);}
    return;
  }
  if(!job.data)return;
  let field=document.querySelector('input[type=file]');
  if(!field){
    const toggle=job.provider==='baidu'?'.graph-d20-search-wrapper-camera':'button[aria-label*="image" i],.cbir-panel__button,.input__cbir-button';
    document.querySelector(toggle)?.click();
    field=await waitFor(()=>document.querySelector('input[type=file]'));
  }
  if(!field){await request('done');notice('XI: The provider could not accept the automatic upload. Use its image upload button to select your file.');return;}
  const comma=job.data.indexOf(','),type=job.data.slice(5,job.data.indexOf(';'));
  const bytes=Uint8Array.from(atob(job.data.slice(comma+1)),c=>c.charCodeAt(0));
  const transfer=new DataTransfer();transfer.items.add(new File([bytes],job.name||'image.'+type.split('/')[1],{type}));
  field.files=transfer.files;await request('done');
  field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));
})().catch(console.error);
