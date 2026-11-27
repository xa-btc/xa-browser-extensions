'use strict';
(()=>{
  let mode='auto',ladder=[],lastPath=location.pathname;
  function resetPage(){if(location.pathname!==lastPath){ladder=[];lastPath=location.pathname;}}
  function report(){
    resetPage();
    const videos=[...document.querySelectorAll('video')].filter(v=>v.videoHeight);
    const video=videos.find(v=>!v.paused&&!v.ended)||videos[0];
    const detail=JSON.stringify({ladder,width:video?.videoWidth||0,height:video?.videoHeight||0});
    document.dispatchEvent(new CustomEvent('xa-paramount-status',{detail}));
  }
  let ready;
  const initialized=new Promise(resolve=>{ready=resolve;});
  document.addEventListener('xa-paramount-mode',e=>{
    const value=e.detail;
    if(value==='auto'||value==='max'||(typeof value==='string'&&/^[1-9]\d{1,3}$/.test(value))){mode=value;ready();report();}
  });
  document.addEventListener('xa-paramount-read',report);
  function chosen(rows){
    const heights=rows.map(r=>r.h);
    if(mode==='max')return Math.max(...heights);
    const permitted=heights.filter(h=>h<=Number(mode));
    return permitted.length?Math.max(...permitted):Math.min(...heights);
  }
  function remember(rows){
    if(!rows.length)return;
    const tiers=new Map();
    for(const {h,b} of rows)tiers.set(h,Math.max(tiers.get(h)||0,b||0));
    ladder=[...tiers].sort((a,b)=>b[0]-a[0]);report();
  }
  function hls(body){
    const lines=body.split(/\r?\n/),rows=[],groups=new Map();
    for(let i=0;i<lines.length;i++){
      if(!lines[i].startsWith('#EXT-X-STREAM-INF:'))continue;
      const attrs=Object.fromEntries([...lines[i].slice(18).matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,\s]+)/g)].map(m=>[m[1],m[2].replace(/^"|"$/g,'')]));
      const h=Number(attrs.RESOLUTION?.split('x')[1]);if(!h)continue;
      let j=i+1;while(j<lines.length&&!lines[j].trim())j++;
      if(!lines[j]||lines[j].startsWith('#'))continue;
      const row={h,b:Number(attrs.BANDWIDTH)||0,i,j};rows.push(row);
      const codecs=(attrs.CODECS||'').split(',').map(c=>c.split('.')[0]).join(',');
      const key=[codecs,attrs.AUDIO,attrs.VIDEO,attrs['VIDEO-RANGE']].join('/');
      if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);
    }
    remember(rows);
    if(mode==='auto'||rows.length<2)return body;
    const skip=new Set();
    for(const group of groups.values()){
      const height=chosen(group);for(const r of group)if(r.h!==height){skip.add(r.i);skip.add(r.j);}
    }
    return skip.size?lines.filter((_,i)=>!skip.has(i)).join('\n'):body;
  }
  function dash(body){
    const xml=new DOMParser().parseFromString(body,'application/xml');
    if(xml.documentElement.localName!=='MPD')return body;
    const all=[],groups=[];
    for(const set of xml.getElementsByTagNameNS('*','AdaptationSet')){
      const kind=set.getAttribute('contentType')||set.getAttribute('mimeType')||'';
      if(kind&&!kind.startsWith('video'))continue;
      if([...set.getElementsByTagNameNS('*','EssentialProperty')].some(p=>(p.getAttribute('schemeIdUri')||'').includes('thumbnail')))continue;
      const group=[];
      for(const el of set.children){
        if(el.localName!=='Representation')continue;
        const type=el.getAttribute('mimeType')||kind;if(type&&!type.startsWith('video'))continue;
        const h=Number(el.getAttribute('height')||set.getAttribute('height'));
        if(h>0)group.push({h,b:Number(el.getAttribute('bandwidth')),el});
      }
      all.push(...group);groups.push(group);
    }
    remember(all);
    if(mode==='auto')return body;
    let changed=false;
    for(const group of groups){
      if(group.length<2||group.some(r=>r.el.hasAttribute('dependencyId')))continue;
      const height=chosen(group);for(const r of group)if(r.h!==height){r.el.remove();changed=true;}
    }
    return changed?new XMLSerializer().serializeToString(xml):body;
  }
  const isManifest=(url,type)=>/\.(mpd|m3u8)(?:$|[?#])/i.test(url)||/dash\+xml|mpegurl/i.test(type);
  function filter(text){
    resetPage();
    try{
      if(text.trimStart().startsWith('#EXTM3U'))return hls(text);
      if(/<(?:\w+:)?MPD[\s>]/.test(text))return dash(text);
    }catch{/* Preserve the original manifest on parsing errors. */}
    return text;
  }
  const fetchPage=window.fetch;
  window.fetch=async function(...args){
    const response=await fetchPage.apply(this,args);
    if(!response.ok||!isManifest(response.url,response.headers.get('content-type')||''))return response;
    try{
      await Promise.race([initialized,new Promise(resolve=>setTimeout(resolve,100))]);
      const raw=await response.clone().text(),result=filter(raw);
      if(raw===result)return response;
      const headers=new Headers(response.headers);for(const h of ['content-length','content-encoding','etag'])headers.delete(h);
      const copy=new Response(result,{headers,status:response.status,statusText:response.statusText});
      for(const k of ['url','type','redirected'])Object.defineProperty(copy,k,{value:response[k]});
      return copy;
    }catch{return response;}
  };
  const proto=XMLHttpRequest.prototype,cache=new WeakMap(),open=proto.open;
  proto.open=function(...args){cache.delete(this);return open.apply(this,args);};
  for(const prop of ['responseText','response','responseXML']){
    const descriptor=Object.getOwnPropertyDescriptor(proto,prop);if(!descriptor?.get||!descriptor.configurable)continue;
    Object.defineProperty(proto,prop,{...descriptor,get(){
      const value=descriptor.get.call(this);
      if(this.readyState!==4||this.status<200||this.status>=300||!isManifest(this.responseURL,this.getResponseHeader('content-type')||''))return value;
      const binary=value instanceof ArrayBuffer;
      if(typeof value!=='string'&&!(value instanceof Document)&&!binary)return value;
      let record=cache.get(this);
      if(!record){const raw=binary?new TextDecoder().decode(value):typeof value==='string'?value:new XMLSerializer().serializeToString(value);const text=filter(raw);record={text,changed:raw!==text};cache.set(this,record);}
      if(!record.changed)return value;
      if(binary)return record.buffer??=new TextEncoder().encode(record.text).buffer;
      if(typeof value==='string')return record.text;
      return record.xml??=new DOMParser().parseFromString(record.text,'application/xml');
    }});
  }
  document.addEventListener('loadedmetadata',report,true);document.addEventListener('resize',report,true);
  document.dispatchEvent(new Event('xa-paramount-ready'));
})();
