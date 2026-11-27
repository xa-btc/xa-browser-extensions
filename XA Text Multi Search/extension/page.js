'use strict';
(() => {
  const owned=new WeakSet();
  const host=document.createElement('div'); owned.add(host);
  const topFrame=window===top, shadow=host.attachShadow({mode:'closed'});
  let shortcuts={},port, ui, rows=[], prefs=XT.defaults, open=false, ready=false, lastUrl='', timer, frameRequest;
  let hits=[], groups=[], marks=[], parentBlocked=false, dirtyMarkers=true, sheet=new CSSStyleSheet(), registered=[];
  const roots=new Set(), mirrors=new Map(), media=matchMedia('(prefers-color-scheme: dark)');
  const rail=document.createElement('canvas'); owned.add(rail);
  rail.setAttribute('aria-label','Search result positions');
  const set=(el,key,value)=>el.style.setProperty(key,value,'important');
  for(const [key,value] of Object.entries({position:'fixed',right:'0',top:'0',height:'100vh',width:'14px','z-index':'2147483645',cursor:'pointer',margin:'0',padding:'0',border:'0',background:'transparent'}))set(rail,key,value);
  function send(message){try{port?.postMessage(message);}catch{}}
  const dark=()=>prefs.theme==='dark'||(prefs.theme==='system'&&media.matches);
  const colors=()=>dark()?prefs.dark:prefs.light;
  const shade=i=>rows[i].color || colors()[rows[i].slot%colors().length];
  function panel(){
    if(!topFrame)return;
    if(open && !ui){
      document.documentElement.append(host); ui=createXTPanel(send,host,shadow);ui.shortcuts(shortcuts);ui.render({rows,prefs});
    }
    ui?.panel(open);
  }
  const observer=new MutationObserver(records=>{
    if(records.some(r=>!owned.has(r.target) && (r.type!=='childList'||[...r.addedNodes,...r.removedNodes].some(n=>!owned.has(n)))))schedule();
  });
  function watch(root){
    observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden','style','class','open','type']});
  }
  function schedule(){if(!timer)timer=setTimeout(()=>{timer=0;scan();},90);}
  function connect(){
    try{
      port=chrome.runtime.connect({name:'xt-page'});
      port.onDisconnect.addListener(()=>{port=null;if(chrome.runtime?.id)setTimeout(connect,500);});
      port.onMessage.addListener(message=>{
        if(message.type==='init'||message.type==='model'){
          prefs=message.prefs;rows=message.rows;ready=true;parentBlocked=!!message.parentBlocked;
          if(message.type==='init')open=!!message.open;
          ui?.render({rows,prefs});if(message.type==='init')panel();schedule();
        } else if(message.type==='panel'){open=message.open;panel();schedule();}
        else if(message.type==='counts') ui?.counts(message.counts,message.total);
        else if(message.type==='site'){if(parentBlocked!==message.blocked){parentBlocked=message.blocked;schedule();}}
        else if(message.type==='shortcuts'){shortcuts=message.keys;ui?.shortcuts(shortcuts);}
        else if(message.type==='listSaved')ui?.ack(message.revision);
        else if(message.type==='tone'){if(document.visibilityState==='visible')tone();}
        else if(message.type==='flash')flash();
        else if(message.type==='unfocus'){CSS.highlights.delete('xt-current');layoutSoon();}
        else if(message.type==='jump')jump((message.row<0?hits:groups[message.row])?.[message.index]);
        else if(message.type==='add'||message.type==='similar')addSelection(message);
        else if(message.type==='error')ui?.status(message.text);
      });
    }catch{}
  }
  chrome.runtime.onMessage.addListener((message,sender,reply)=>{if(message.type==='wake'){if(!port)connect();reply(true);}});
  function addSelection(message){
    const selection=getSelection(),text=(message.text||selection?.toString()||'').trim();
    if(!text)return;
    const values=new Set([text]);
    if(message.type==='similar'&&selection?.rangeCount){
      const node=selection.getRangeAt(0).startContainer;
      const el=node.nodeType===Node.TEXT_NODE?node.parentElement:node;
      if(el?.textContent.trim()===text){
        const path=element=>{const tags=[];for(let p=element;p&&p!==document.body;p=p.parentElement)tags.push([p.localName,[...p.classList].sort()]);return JSON.stringify(tags);};
        const signature=path(el);
        for(const other of document.getElementsByTagName(el.localName))if(path(other)===signature && other.textContent.trim())values.add(other.textContent.trim());
      }
    }
    send({type:'append',values:[...values]});
  }
  const brightSpans=[],splitPieces=[],textItems=new Set();
  function detachPaint(){
    for(const span of brightSpans)if(span.parentNode)span.replaceWith(...span.childNodes);
    brightSpans.length=0;
    // Rejoin only text nodes split by this renderer and still adjacent.
    for(let i=splitPieces.length-1;i>=0;i--){
      const [before,after]=splitPieces[i];
      if(before.nextSibling===after){before.appendData(after.data);after.remove();}
    }
    splitPieces.length=0;
    for(const item of textItems)if(item.parentNode)item.replaceWith(...item.childNodes);
    textItems.clear();
    for(const name of registered)CSS.highlights.delete(name);
    registered=[];CSS.highlights.delete('xt-current');
    for(const mirror of mirrors.values())mirror.host.remove();
    mirrors.clear();rail.remove();marks=[];
  }
  function attachSheet(root){
    if(!root.adoptedStyleSheets.includes(sheet))root.adoptedStyleSheets=[...root.adoptedStyleSheets,sheet];
    roots.add(root);
  }
  function highlightInk(row,color){
    const ink=prefs[dark()?'darkInk':'lightInk']?.[row.slot%colors().length];
    if(!row.color&&ink)return ink;
    const luminance=[1,3,5].map(at=>parseInt(color.slice(at,at+2),16)).reduce((sum,x,j)=>sum+x*[.299,.587,.114][j],0);
    return luminance>140?'#101521':'#ffffff';
  }
  function styleBrightMatch(span,rowIndex){
    const row=rows[rowIndex],color=shade(rowIndex),mode=row.position||prefs.position;
    const left=mode==='exact'||mode==='initial'?'.7em':'.2em';
    const right=mode==='exact'||mode==='final'?'.7em':'.2em';
    set(span,'background-color',color);set(span,'color',highlightInk(row,color));
    set(span,'-webkit-text-fill-color','currentColor');
    set(span,'border-radius',[left,right,right,left].join(' '));
    if(prefs.style==='glow')set(span,'box-shadow',`0 0 .5em .1em ${color}, .1em .2em .2em #0004`);
  }
  function needsNativePaint(node){
    let parent=node.assignedSlot||node.parentElement||node.getRootNode().host;
    while(parent){
      const display=getComputedStyle(parent).display;
      if(display!=='contents')return /flex|grid|table|ruby/.test(display)&&display!=='table-cell'&&display!=='table-caption';
      parent=parent.assignedSlot||parent.parentElement||parent.getRootNode().host;
    }
    return false;
  }
  function groupLayoutText(node){
    // Keep the whole anonymous flex/grid item together while painting inside it.
    let first=node;
    while(first.previousSibling?.nodeType===Node.TEXT_NODE)first=first.previousSibling;
    const item=document.createElement('span');
    set(item,'all','unset');set(item,'display','block');
    first.before(item);
    while(item.nextSibling?.nodeType===Node.TEXT_NODE)item.append(item.nextSibling);
    textItems.add(item);
  }
  // Partition each text node at match boundaries so overlapping searches and
  // phrases crossing inline elements retain their own navigation ranges.
  function paintFragments(segments,matches){
    const starts=new Map(),ends=new Map();
    function at(map,key,hit){
      if(!map.has(key))map.set(key,[]);
      map.get(key).push(hit);
    }
    for(const hit of matches){at(starts,hit.start,hit);at(ends,hit.end,hit);}
    const cuts=[...new Set([...starts.keys(),...ends.keys()])].sort((a,b)=>a-b);
    const active=new Set();
    let cut=0;
    for(const part of segments){
      let tail=part.node,offset=part.start;
      while(offset<part.end){
        for(const h of ends.get(offset)||[])active.delete(h);
        for(const h of starts.get(offset)||[])active.add(h);
        if(cuts[cut]===offset)cut++;
        const end=Math.min(part.end,cuts[cut]??part.end);
        const next=end<part.end?tail.splitText(end-offset):null;
        if(next)splitPieces.push([tail,next]);
        if(active.size){
          let row=0;
          for(const h of active){row=Math.max(row,h.row);h.first??=tail;h.last=tail;}
          const span=document.createElement('span');
          set(span,'all','unset');
          set(span,'display','inline');
          styleBrightMatch(span,row);
          tail.before(span);span.append(tail);brightSpans.push(span);
        }
        tail=next;offset=end;
      }
    }
    for(const h of matches){
      h.range.setStart(h.first,0);h.range.setEnd(h.last,h.last.length);
      delete h.first;delete h.last;
    }
  }
  function paintStyles(pulse=false){
    const rules=rows.map((row,i)=>{
      const color=shade(i);
      const solid='background-color:'+color+';color:'+highlightInk(row,color);
      const glow='text-shadow:0 0 2px '+color+',0 0 5px '+color+';text-decoration:underline '+color;
      let style=prefs.style==='glow'?glow:solid;
      if(prefs.bright)style='';
      if(prefs.style==='none')style='';
      if(pulse)style='background-color:#ffffff;color:#111111';
      const nativeBright=solid+(prefs.style==='glow'?';text-shadow:0 0 .4em '+color:'');
      return '::highlight(xt-term-'+i+'){'+style+'}::highlight(xt-bright-'+i+'){'+(pulse?style:nativeBright)+'}';
    });
    rules.push('::highlight(xt-current){background-color:#142740;color:white;text-decoration:underline #ffb83a 2px}');
    sheet.replaceSync(rules.join('\n'));
  }
  let flashTimers=[];
  function flash(){
    for(const timer of flashTimers)clearTimeout(timer);
    paintStyles(true);flashTimers=[setTimeout(()=>paintStyles(),150),setTimeout(()=>paintStyles(true),300),setTimeout(()=>paintStyles(),450)];
  }
  function fieldEligible(el){return prefs.fields && (el.localName==='textarea'||(el.localName==='input'&&['text','search','url','email','tel'].includes(el.type)));}
  function scan(){
    if(!ready)return;
    detachPaint();hits=[];groups=rows.map(()=>[]);dirtyMarkers=true;
    if(lastUrl!==location.href){lastUrl=location.href;if(topFrame)send({type:'location',url:lastUrl});}
    observer.disconnect();
    for(const root of roots)if(root!==document&&!root.host?.isConnected)roots.delete(root);
    const allowed=(topFrame||!parentBlocked) && XT.allowed(location.href,prefs);
    if(topFrame)ui?.status(allowed?'':'Search is disabled here by your site rules.');
    if(!allowed||!rows.length||prefs.visibility==='never'||(prefs.visibility==='panel'&&!open)){
      send({type:'counts',counts:groups.map(()=>0)});return;
    }
    watch(document);attachSheet(document);paintStyles();
    let sequence=0, segments=[], text='';
    function flush(){
      if(!text){segments=[];return;}
      const cache=new Map(), ranges=segments, matches=[];
      function boundary(index,end){
        let lo=0,hi=ranges.length-1;
        while(lo<hi){const mid=(lo+hi)>>1;if(ranges[mid].end<index||(!end&&ranges[mid].end===index))lo=mid+1;else hi=mid;}
        const part=ranges[lo];return [part.node,index-part.start];
      }
      for(const [i,row] of rows.entries()){
        if(!row.enabled)continue;
        for(const [start,end] of XT.find(text,row,prefs,cache)){
          const range=new Range();range.setStart(...boundary(start,false));range.setEnd(...boundary(end,true));
          const hit={row:i,order:sequence,start,end,range};hits.push(hit);groups[i].push(hit);matches.push(hit);
        }
      }
      if(prefs.bright&&prefs.style!=='none'&&matches.length){
        // A wrapper around part of an anonymous flex or grid item changes how the page lays it out.
        const sensitive=ranges.filter(part=>needsNativePaint(part.node));
        const canGroup=prefs.style==='glow'&&sensitive.every(({node})=>node.parentElement&&!node.assignedSlot&&/^(inline-)?(flex|grid)$/.test(getComputedStyle(node.parentElement).display));
        if(sensitive.length&&!canGroup){
          for(const hit of matches)hit.nativeBright=true;
        }else{
          for(const {node} of sensitive)if(node.data.trim()&&!textItems.has(node.parentNode))groupLayoutText(node);
          paintFragments(ranges,matches);
        }
      }
      sequence++;segments=[];text='';
    }
    function walk(node){
      if(node.nodeType===3){if(node.data){segments.push({node,start:text.length,end:text.length+node.data.length});text+=node.data;}return;}
      if(node.nodeType!==1&&node.nodeType!==11)return;
      if(owned.has(node))return;
      if(node.nodeType===11){for(const child of [...node.childNodes])walk(child);return;}
      if(['script','style','noscript','template','head','canvas','svg','select','option'].includes(node.localName)||node.hidden||(!prefs.editable&&node.isContentEditable))return;
      const css=getComputedStyle(node);
      if(css.display==='none'||css.visibility==='hidden'||css.contentVisibility==='hidden')return;
      if(node.localName==='input'||node.localName==='textarea'){
        flush();
        if(fieldEligible(node)){
          const cache=new Map(), entries=[];
          for(const [i,row] of rows.entries())if(row.enabled)for(const [start,end] of XT.find(node.value,row,prefs,cache)){
            const hit={row:i,order:sequence,start,end,field:node};entries.push(hit);hits.push(hit);groups[i].push(hit);
          }
          if(entries.length)makeMirror(node,entries);
          sequence++;
        }
        return;
      }
      const block=!['inline','contents','inline-block'].includes(css.display)||node.localName==='br';
      if(block)flush();
      if(node.shadowRoot){flush();watch(node.shadowRoot);attachSheet(node.shadowRoot);walk(node.shadowRoot);flush();}
      else for(const child of [...node.childNodes])walk(child);
      if(block)flush();
    }
    if(document.body)walk(document.body);flush();
    hits.sort((a,b)=>a.order-b.order||a.start-b.start||a.row-b.row);
    for(const [i,group] of groups.entries()){
      const highlight=new Highlight();
      for(const h of group)if(h.range)highlight.add(h.range);
      const name='xt-term-'+i;CSS.highlights.set(name,highlight);registered.push(name);
      const nativeBright=new Highlight();
      for(const hit of group)if(hit.nativeBright)nativeBright.add(hit.range);
      if(nativeBright.size){
        const brightName='xt-bright-'+i;CSS.highlights.set(brightName,nativeBright);registered.push(brightName);
      }
    }
    observer.takeRecords();
    send({type:'counts',counts:groups.map(group=>group.length)});
    layoutSoon();
  }
  function makeMirror(field,entries){
    const layer=document.createElement('div');owned.add(layer);
    for(const [key,value] of Object.entries({position:'fixed','z-index':'2147483600','pointer-events':'none',overflow:'hidden',margin:'0',background:'transparent'}))set(layer,key,value);
    const root=layer.attachShadow({mode:'closed'}),inner=document.createElement('div');
    inner.style.color='transparent';inner.style.boxSizing='border-box';inner.style.position='absolute';inner.style.margin='0';
    const css=getComputedStyle(field);
    for(const prop of ['font','letterSpacing','lineHeight','textAlign','textIndent','tabSize','direction','padding','wordSpacing','textTransform'])
      inner.style[prop]=css[prop];
    inner.style.whiteSpace=field.localName==='textarea'?'pre-wrap':'pre';inner.style.overflowWrap='break-word';
    const value=field.value;let last=0;
    for(const hit of entries.sort((a,b)=>a.start-b.start||b.end-a.end)){
      if(hit.start<last)continue;
      inner.append(document.createTextNode(value.slice(last,hit.start)));
      const marker=document.createElement('span');marker.textContent=value.slice(hit.start,hit.end);
      const color=shade(hit.row);
      marker.style.backgroundColor=prefs.style==='none'?'transparent':color;marker.style.opacity='.46';
      if(prefs.bright&&prefs.style!=='none'){
        marker.style.opacity='1';styleBrightMatch(marker,hit.row);
      }
      inner.append(marker);last=hit.end;
    }
    inner.append(document.createTextNode(value.slice(last)));root.append(inner);document.documentElement.append(layer);
    mirrors.set(field,{host:layer,inner});
  }
  function layoutSoon(){if(frameRequest)return;frameRequest=requestAnimationFrame(()=>{frameRequest=0;layout();});}
  function rect(hit){return hit.range?.getBoundingClientRect() || hit.field.getBoundingClientRect();}
  function layout(){
    for(const [field,{host,inner}] of mirrors){
      const r=field.getBoundingClientRect();set(host,'left',r.left+field.clientLeft+'px');set(host,'top',r.top+field.clientTop+'px');
      set(host,'width',field.clientWidth+'px');set(host,'height',field.clientHeight+'px');inner.style.width=field.clientWidth+'px';
      inner.style.left=-field.scrollLeft+'px';inner.style.top=-field.scrollTop+'px';
    }
    if(!dirtyMarkers)return;dirtyMarkers=false;
    if(!prefs.marks||!hits.length){rail.remove();return;}
    set(rail,'left',prefs.markSide==='left'?'0':'auto');set(rail,'right',prefs.markSide==='left'?'auto':'0');
    if(!rail.isConnected)document.documentElement.append(rail);
    const height=Math.max(1,innerHeight),docHeight=Math.max(document.scrollingElement?.scrollHeight||0,height);
    const width=14,scale=devicePixelRatio||1;
    rail.width=Math.round(width*scale);rail.height=Math.round(height*scale);
    const ctx=rail.getContext('2d');marks=[];
    ctx.scale(rail.width/width,rail.height/height);
    const left=prefs.markSide==='left',base=left?2:width-2,tip=left?width-2:2;
    for(const hit of hits){const r=rect(hit);if(!r.height)continue;
      const y=Math.min(height-6,Math.max(6,(r.top+scrollY)*height/docHeight));
      ctx.beginPath();ctx.moveTo(base,y-5);ctx.lineTo(tip,y);ctx.lineTo(base,y+5);ctx.closePath();
      ctx.fillStyle=shade(hit.row);ctx.fill();ctx.strokeStyle='rgba(40,40,40,.75)';ctx.stroke();
      marks.push({y,hit});
    }
  }
  rail.onclick=e=>{if(marks.length)jump(marks.reduce((a,b)=>Math.abs(a.y-e.clientY)<=Math.abs(b.y-e.clientY)?a:b).hit);};
  function jump(hit){
    if(!hit)return;
    const el=hit.field||hit.range.startContainer.parentElement;el.scrollIntoView({block:'center',inline:'nearest'});
    if(hit.range){
      const r=rect(hit);if(r.top<0||r.bottom>innerHeight)scrollBy(0,r.top-innerHeight/2);
      const current=new Highlight(hit.range);current.priority=100;CSS.highlights.set('xt-current',current);
    }else{el.focus({preventScroll:true});try{el.setSelectionRange(hit.start,hit.end);}catch{}}

  }
  let audio;
  function tone(){
    try{audio??=new AudioContext();if(audio.state==='suspended')audio.resume().catch(()=>{});
      const osc=audio.createOscillator(),gain=audio.createGain();osc.frequency.value=prefs.sound==='chime'?790:430;
      gain.gain.setValueAtTime(.045,audio.currentTime);gain.gain.exponentialRampToValueAtTime(.001,audio.currentTime+.09);
      osc.connect(gain);gain.connect(audio.destination);osc.start();osc.stop(audio.currentTime+.10);
    }catch{}
  }
  document.addEventListener('input',e=>{if(ready&&prefs.fields&&fieldEligible(e.target))schedule();},true);
  addEventListener('scroll',e=>{if(e.target!==document && e.target!==window)dirtyMarkers=true;layoutSoon();},true);
  addEventListener('resize',()=>{dirtyMarkers=true;layoutSoon();});
  media.addEventListener('change',schedule);addEventListener('popstate',schedule);
  if(window.navigation)navigation.addEventListener('currententrychange',schedule);
  addEventListener('pageshow',()=>{if(ready)schedule();});
  connect();
})();

