'use strict';
globalThis.createXTPanel = function(send, host, shadow) {
  for(const [property,value] of Object.entries({all:'initial',position:'fixed','z-index':'2147483647',font:'13px/1.4 system-ui,sans-serif','color-scheme':'light dark'}))
    host.style.setProperty(property,value,'important');
  const paletteMedia=matchMedia('(prefers-color-scheme: dark)');
  const sheet=new CSSStyleSheet();
  sheet.replaceSync(`
    *,*:before,*:after{box-sizing:border-box}
    [hidden]{display:none!important}
    .box{--bg:#202124;--fg:#f1f2f5;--line:#454854;--chip:#303239;--blue:#adcaff;--well:#181b25;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:9px;width:min(636px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;box-shadow:0 6px 28px #0006;padding:10px;font:13px/1.35 system-ui,sans-serif;color-scheme:dark}
    .light{--bg:#f6f8fc;--fg:#192137;--line:#abb8cb;--chip:#e6ecf5;--blue:#214f98;--well:#edf1fa;color-scheme:light}
    header,.bar,.tools,.entry,.modes{display:flex;align-items:center;gap:4px}
    header,.tools,.bar{flex-wrap:wrap}
    header{cursor:move;touch-action:none;padding-bottom:6px}
    header strong{display:inline-flex;align-items:center;gap:6px;margin-right:auto}
    header strong img{display:block;width:24px;height:24px;flex:none;pointer-events:none}
    button,select,input,textarea{font:inherit;color:inherit;background:var(--chip);border:1px solid var(--line);border-radius:4px;padding:2px 6px}
    button{cursor:pointer;min-height:23px}button:hover,button:focus-visible,summary:focus-visible{outline:1px solid var(--blue)}
    button[aria-pressed=true]{background:var(--blue);color:var(--well)}
    .tools,.modes{padding:5px 0}.modes button{flex:1}
    .controls,.list{background:var(--well);padding:0 7px;border:1px solid var(--line)}.controls{border-radius:6px 6px 0 0}.list{border-radius:0 0 6px 6px}
    .list button{font-size:12px}.bar{padding:4px 0}.bar strong{margin-right:auto}
    .entry{min-width:0;padding:1px 0;gap:3px}.entries{margin-top:4px}
    .term-track{flex:1;min-width:0;overflow-x:auto;background:var(--well);scrollbar-width:thin}
    .inline-edit,.add-row input{width:100%;min-width:0}.add-row{display:flex;gap:4px;margin-top:4px}.term{display:flex;min-width:100%;align-items:center;white-space:pre;border:0;background:transparent;padding:1px 2px}
    .token,.count{color:var(--ink);background:var(--color);padding:1px 3px;border-radius:3px}
    .entry.muted .term{opacity:.55}.count{text-align:center;min-width:3ch;font-variant-numeric:tabular-nums}
    details>summary{cursor:pointer;color:var(--blue);padding:4px 0}
    textarea{display:block;width:100%;min-height:64px;margin:5px 0;resize:vertical}
    label{display:inline-flex;align-items:center;gap:3px}input[type=color]{width:35px;padding:1px}
    .properties{padding:7px 0}.properties input[type=text]{max-width:130px}small{color:var(--blue)}
  `);
  shadow.adoptedStyleSheets=[sheet];
  const node=(tag,text)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;return el;};
  const box=node('div'); box.className='box';shadow.append(box);
  let revision=0,pending=0;
  let data={rows:[],prefs:XT.defaults},counts=[],total=0,selected=-1,open=false,dragged=false;
  const emit=(type,extra={})=>send({type,...extra});
  const prefs=patch=>emit('prefs',{patch});
  const commit=rows=>{pending=++revision;data={...data,rows};emit('list',{rows,revision});};
  function button(parent,label,callback){
    const b=node('button',label);b.type='button';b.onclick=callback;parent.append(b);return b;
  }
  function detail(parent,name) {
    const d=node('details'),s=node('summary',name);d.append(s);parent.append(d);return d;
  }
  const header=node('header'),name=node('strong'),counter=node('span','0 matches');
  const icon=node('img');
  icon.src=chrome.runtime.getURL('icons/48.png');
  icon.alt='';
  icon.draggable=false;
  name.append(icon,'Text Multi Search');box.append(header);header.append(name);
  const flash=button(header,'Flash',()=>emit('flash'));
  const pin=button(header,'Pin',()=>prefs({pinned:!data.prefs.pinned}));
  const close=button(header,'Close',()=>emit('panel',{open:false}));
  const bar=node('div');bar.className='bar';box.append(bar);bar.append(node('strong','Search expressions'),counter);
  function arrow(parent,label,glyph,callback){
    const b=button(parent,label,callback);b.textContent=glyph;b.setAttribute('aria-label',label);b.title=label;return b;
  }
  const prev=arrow(bar,'Previous','‹',()=>emit('navigate',{row:-1,step:-1}));
  const nextMatch=arrow(bar,'Next','›',()=>emit('navigate',{row:-1,step:1}));
  const search=node('div');search.className='controls';box.append(search);
  const modes=node('div');modes.className='modes';modes.append(node('span','Match'));search.append(modes);
  const modeButtons=new Map();
  for(const mode of XT.locations){
    const b=button(modes,mode[0].toUpperCase()+mode.slice(1),()=>{
      if(data.rows.some(r=>r.position))commit(data.rows.map(r=>({...r,position:''})));
      prefs({position:mode});
    });
    b.title='Apply '+mode+' matching to every expression';modeButtons.set(mode,b);
  }
  const list=node('div'),tools=node('div');list.className='list';tools.className='tools';list.append(tools);box.append(list);
  const edit=detail(box,'Edit expressions');
  const editor=node('textarea');editor.placeholder='One expression per line';editor.setAttribute('aria-label','Search expressions');edit.append(editor);
  edit.ontoggle=()=>{if(edit.open&&open)editor.focus({preventScroll:true});};
  editor.oninput=()=>commit(XT.reconcile(editor.value,data.rows));
  const hits=node('div');hits.className='entries';box.append(hits);
  const entries=hits;
  const addRow=node('form');addRow.className='add-row';box.append(addRow);
  const newGroup=node('input');newGroup.setAttribute('aria-label','New expression group');
  const addButton=node('button','Add group');addButton.type='submit';addRow.append(newGroup,addButton);
  addRow.onsubmit=e=>{
    e.preventDefault();const text=newGroup.value.trim();if(!text)return;
    commit([...data.rows,...XT.terms([{text,slot:data.rows.length}])]);
    newGroup.value='';newGroup.focus();
  };
  button(tools,'Undo',()=>emit('undo'));button(tools,'Redo',()=>emit('redo'));
  button(tools,'A–Z',()=>commit([...data.rows].sort((a,b)=>a.text.localeCompare(b.text))));
  button(tools,'By count',()=>commit(data.rows.map((r,i)=>({r,n:counts[i]||0})).sort((a,b)=>b.n-a.n).map(x=>x.r)));
  button(tools,'Reset colors',()=>commit(data.rows.map((r,slot)=>({...r,slot,color:''}))));
  button(tools,'Clear found',()=>commit(data.rows.filter((_,i)=>!counts[i])));
  button(tools,'Clear unfound',()=>commit(data.rows.filter((_,i)=>counts[i])));
  button(tools,'Clear all',()=>commit([]));
  const file=node('input');file.type='file';file.accept='.json,.txt';file.hidden=true;tools.append(file);
  const status=node('small');box.append(status);
  button(tools,'Import',()=>file.click());
  file.onchange=async()=>{try{const f=file.files[0];if(!f)return;const text=await f.text();commit(/\.json$/i.test(f.name)?XT.terms(JSON.parse(text)):XT.reconcile(text,[]));status.textContent='';}catch(e){status.textContent=e.message;}finally{file.value='';}};
  function save(type){
    const value=type==='json'?JSON.stringify(data.rows,null,2):data.rows.map(r=>r.text).join('\n');
    const a=node('a');a.href=URL.createObjectURL(new Blob([value],{type:type==='json'?'application/json':'text/plain'}));a.download='XA search list.'+type;
    shadow.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),2000);
  }
  button(tools,'Export JSON',()=>save('json'));button(tools,'Export text',()=>save('txt'));
  const switches=node('div');switches.className='tools';search.append(switches);
  const toggles={};
  for(const [key,label] of Object.entries({caseSensitive:'Case',accents:'Accents',wild:'Wildcards',bright:'Bright highlights',marks:'Page markers'}))
    toggles[key]=button(switches,label,()=>prefs({[key]:!data.prefs[key]}));
  const side=button(switches,'',()=>prefs({markSide:data.prefs.markSide==='left'?'right':'left'}));
  side.title='Move page markers to the opposite edge';
  const visibility=button(switches,'Highlights',()=>prefs({visibility:({always:'panel',panel:'never',never:'always'})[data.prefs.visibility]}));
  const theme=button(switches,'Theme',()=>prefs({theme:({system:'dark',dark:'light',light:'system'})[data.prefs.theme]}));
  const settings=button(switches,'Settings & site rules',()=>emit('settings'));
  for(const b of [theme,settings,pin,close])header.append(b);
  const help=detail(box,'Search help');help.append(node('p','Separate alternatives on one line with the configured separator. Enter or Shift+Enter outside the list moves through matches. Wildcards: * for any length, ? for one letter or digit, ! for zero or one. Use ?{n} or !{n} for counts.'));
  const dark=()=>data.prefs.theme==='dark'||(data.prefs.theme==='system'&&paletteMedia.matches);
  function updateRow(i,patch){commit(data.rows.map((r,j)=>i===j?{...r,...patch}:r));}
  function select(parent,label,values,value,change){
    const l=node('label',label),el=node('select');l.append(el);parent.append(l);
    for(const [v,t] of values){const o=node('option',t);o.value=v;el.append(o);}el.value=value;el.onchange=()=>change(el.value);
  }
  let activeRow=null;
  function renderRows(){
    if(activeRow&&shadow.activeElement===activeRow.input&&data.rows[activeRow.index]?.text===activeRow.saved)return;
    activeRow=null;
    entries.replaceChildren();
    data.rows.forEach((r,i)=>{
      const line=node('div');line.className='entry';entries.append(line);
      const colors=dark()?data.prefs.dark:data.prefs.light;
      const swatch=r.color||colors[r.slot%colors.length];
      line.style.setProperty('--color',swatch);
      const rgb=swatch.slice(1).match(/../g).map(hex=>parseInt(hex,16));
      const lightness=rgb.reduce((sum,v,j)=>sum+[.2126,.7152,.0722][j]*((v/255+.055)/1.055)**2.4,0);
      const inks=dark()?data.prefs.darkInk:data.prefs.lightInk;
      line.style.setProperty('--ink',(!r.color&&inks?.[r.slot%colors.length])||(lightness>.18?'#101114':'#ffffff'));
      line.classList.toggle('muted',!r.enabled);
      const show=arrow(line,(r.enabled?'Hide ':'Show ')+r.text,r.enabled?'◉':'○',()=>updateRow(i,{enabled:!r.enabled}));
      show.hidden=data.prefs.hidden.includes('parameters');
      const propertiesToggle=()=>{selected=selected===i?-1:i;renderRows();};
      const options=arrow(line,'Options for '+r.text,'⋮',propertiesToggle);
      options.hidden=show.hidden;options.setAttribute('aria-expanded',String(selected===i));
      const track=node('div');track.className='term-track';line.append(track);
      const term=button(track,'',()=>{
        const input=node('input');input.className='inline-edit';input.value=data.rows[i].text;
        input.setAttribute('aria-label','Edit expression group');
        const draft={index:i,input,saved:input.value};activeRow=draft;
        term.hidden=true;track.append(input);input.focus();input.setSelectionRange(input.value.length,input.value.length);
        input.oninput=()=>{
          const value=input.value.trim();
          if(value&&value!==draft.saved){draft.saved=value;updateRow(i,{text:value});}
        };
        input.onblur=()=>{
          if(activeRow!==draft)return;
          activeRow=null;
          term.hidden=false;input.remove();
          paintTerm(draft.saved);
          for(const [control,label] of [[show,(r.enabled?'Hide ':'Show ')+draft.saved],[options,'Options for '+draft.saved]]){
            control.title=label;control.setAttribute('aria-label',label);
          }
          back.title='Previous '+draft.saved;forward.title='Next '+draft.saved;
        };
        input.onkeydown=e=>{
          if(e.key==='Enter'&&!e.isComposing){e.preventDefault();term.hidden=false;term.focus();}
        };
      });term.className='term';term.title='Edit '+r.text;
      function paintTerm(text){
        const separator=data.prefs.separator;
        term.title='Edit '+text;term.replaceChildren();
        (separator?text.split(separator):[text]).forEach((part,j)=>{
          if(j)term.append(separator);
          const token=node('span',part);token.className='token';term.append(token);
        });
      }
      paintTerm(r.text);
      const count=node('span',String(counts[i]||0));count.className='count';line.append(count);
      const back=button(line,'‹',()=>emit('navigate',{row:i,step:-1}));back.title='Previous '+r.text;back.hidden=data.prefs.hidden.includes('termNav');
      const forward=button(line,'›',()=>emit('navigate',{row:i,step:1}));forward.title='Next '+r.text;forward.hidden=data.prefs.hidden.includes('termNav');
      if(selected!==i)return;
      const properties=node('div');properties.className='properties tools';entries.append(properties);
      button(properties,r.enabled?'Hide term':'Show term',()=>updateRow(i,{enabled:!r.enabled}));
      const color=node('input');color.type='color';color.value=r.color||colors[r.slot%colors.length];color.title='Highlight color';color.onchange=()=>updateRow(i,{color:color.value});properties.append(color);
      select(properties,'Match',[['','Default'],...XT.locations.map(x=>[x,x])],r.position,v=>updateRow(i,{position:v}));
      for(const [key,label] of [['caseSensitive','Case'],['accents','Accents']])
        select(properties,label,[['','Default'],['true','Sensitive'],['false','Ignore']],r[key]==null?'':String(r[key]),v=>updateRow(i,{[key]:v===''?null:v==='true'}));
      const note=node('input');note.type='text';note.value=r.note;note.placeholder='Annotation';note.onchange=()=>updateRow(i,{note:note.value});properties.append(note);
    });
  }
  function place(){
    if(dragged)return;
    const [v,h]=data.prefs.corner.split('-');
    for(const side of ['top','right','bottom','left'])host.style.setProperty(side,side===v||side===h?'12px':'auto','important');
  }
  function render(next){
    data=pending?{...next,rows:data.rows}:next;
    const words=data.rows.map(r=>r.text).join('\n');
    if(XT.reconcile(editor.value,data.rows).map(r=>r.text).join('\n')!==words)editor.value=words;
    box.classList.toggle('light',!dark());box.style.opacity=data.prefs.opacity/100;
    const hidden=new Set(data.prefs.hidden);
    for(const [el,key] of [[list,'listTools'],[search,'controls'],[help,'help'],[hits,'expressions'],[flash,'flash'],[close,'close'],[pin,'pin'],[theme,'theme'],[settings,'settings']])el.hidden=hidden.has(key);
    for(const b of [prev,nextMatch])b.hidden=hidden.has('navigation');
    for(const [mode,b] of modeButtons)b.setAttribute('aria-pressed',String(data.rows.length?data.rows.every(r=>(r.position||data.prefs.position)===mode):data.prefs.position===mode));
    counter.hidden=hidden.has('counter');
    pin.setAttribute('aria-pressed',data.prefs.pinned);
    for(const [key,b] of Object.entries(toggles)){b.setAttribute('aria-pressed',data.prefs[key]);b.hidden=hidden.has(key);}
    side.textContent='Markers: '+data.prefs.markSide;side.hidden=hidden.has('marks');
    newGroup.placeholder=data.prefs.separator?['one','two','three'].join(data.prefs.separator):'New expression';
    addRow.hidden=hidden.has('expressions');
    visibility.textContent='Highlights: '+data.prefs.visibility;visibility.hidden=hidden.has('visibility');
    theme.textContent='Theme: '+data.prefs.theme;
    place();renderRows();
  }
  function panel(value){
    open=value;host.style.setProperty('display',value?'block':'none','important');
    if(value){if(data.prefs.opening!=='preserve')edit.open=true;
      (edit.open?editor:addRow.hidden?edit.firstElementChild:newGroup).focus({preventScroll:true});
      if(data.prefs.opening==='all')editor.select();
      if(data.prefs.opening==='new'){editor.value=editor.value.replace(/\n+$/,'')+(editor.value?'\n':'');editor.selectionStart=editor.selectionEnd=editor.value.length;}
    }
  }
  shadow.addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.preventDefault();emit('panel',{open:false});}
    if(e.key==='Enter' && (e.target!==editor && !['INPUT','SELECT','BUTTON','SUMMARY'].includes(e.target.tagName)||e.ctrlKey)){e.preventDefault();emit('navigate',{row:-1,step:e.shiftKey?-1:1});}
    if(e.target!==newGroup&&(e.ctrlKey||e.metaKey)&&['z','y'].includes(e.key.toLowerCase())){e.preventDefault();emit(e.shiftKey||e.key.toLowerCase()==='y'?'redo':'undo');}
    e.stopPropagation();
  });
  let drag;
  header.onpointerdown=e=>{if(e.target.closest('button'))return;const rect=host.getBoundingClientRect();drag=[e.clientX-rect.left,e.clientY-rect.top];header.setPointerCapture(e.pointerId);};
  header.onpointermove=e=>{if(!drag)return;dragged=true;host.style.setProperty('right','auto','important');host.style.setProperty('bottom','auto','important');
    host.style.setProperty('left',Math.max(0,Math.min(innerWidth-host.offsetWidth,e.clientX-drag[0]))+'px','important');
    host.style.setProperty('top',Math.max(0,Math.min(innerHeight-40,e.clientY-drag[1]))+'px','important');};
  header.onpointerup=header.onpointercancel=()=>{drag=null;};
  document.addEventListener('pointerdown',e=>{if(open&&!data.prefs.pinned&&!e.composedPath().includes(host))emit('panel',{open:false});},true);
  paletteMedia.addEventListener('change',()=>render(data));
  function shortcuts(keys){
    const commands={Next:'next',Previous:'prev',Flash:'flash','Clear all':'clear',Case:'case',Accents:'accents','Page markers':'marks'};
    for(const b of box.querySelectorAll('button')){const label=b.getAttribute('aria-label')||b.textContent;if(commands[label]&&keys[commands[label]])b.title=label+' ('+keys[commands[label]]+')';}
    visibility.title=keys.highlights||'No shortcut assigned';
  }
  return {render,panel,shortcuts,ack(value){if(value===pending){pending=0;render(data);}},status:msg=>{status.textContent=msg;},counts(values,n){counts=values;total=n;counter.textContent=total+' match'+(total===1?'':'es');
    [...entries.querySelectorAll('.count')].forEach((el,i)=>el.textContent=String(counts[i]||0));}};
};

