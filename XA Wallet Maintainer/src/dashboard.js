import {chains,units,address,discover,rawAmount} from './model.js';
import {scan} from './network.js';
const $=id=>document.getElementById(id),make=(tag,text)=>{const e=document.createElement(tag);e.textContent=text||'';return e;};
const chosen=new Map(),candidates=new Map(),candidateChecks=new Set();
let accounts=[],records={},history=[],tracked={},controller,visible=[];
async function msg(op,extra={}){const r=await chrome.runtime.sendMessage({op,...extra});if(r?.error)throw Error(r.error);return r;}
function on(id,fn){$(id).onclick=async()=>{try{$('notice').textContent='';await fn();}catch(e){$('notice').textContent=e.message;}};}
function key(chain,owner){return 'scan:'+chain+':'+owner;}
function report(r){
  if(!r)return 'Not scanned';
  const state=r.funded?'Funded':r.used?'Previously used':'No activity detected';
  return (r.errors.length?'Incomplete · ':'')+state;
}
function check(text,checked,change){
  const l=make('label'),box=make('input');box.type='checkbox';box.checked=checked;box.onchange=()=>change(box.checked);
  l.append(box,' '+text);return l;
}
function selection(){$('selection').textContent=chosen.size+' transfer'+(chosen.size===1?'':'s')+' selected';}
function render(){
  const root=$('portfolio');root.replaceChildren();visible=[];const totals=new Map();
  for(const a of accounts)for(const [chain,c] of Object.entries(chains)){
    if((chain==='sol')!==(a.family==='sol')||($('network').value!=='all'&&$('network').value!==chain))continue;
    if(![a.address,...a.labels].join(' ').toLowerCase().includes($('filter').value.trim().toLowerCase()))continue;
    const r=records[key(chain,a.address)];
    if($('hide').checked&&r&&!r.funded&&!r.errors.length)continue;
    if($('used').checked&&!r?.used)continue;
    const row=make('article'),title=make('strong',a.labels.join(' / ')+' · '+c.name);
    row.append(title,make('code',a.address),make('small',report(r)+(r?' · '+new Date(r.time).toLocaleString():'')));
    if(r){
      if(r.errors.length)row.append(make('small',r.errors.join(' · ')));
      const items=[...r.assets];
      if(r.native!==null)items.push({id:'',decimals:chain==='sol'?9:18,symbol:c.coin,amount:r.native,transferable:true});
      for(const asset of items){
        const item={...asset,owner:a.address,chain},id=[chain,a.address,asset.id,asset.account||''].join('/');
        const display=units(asset.amount,asset.decimals)+' '+asset.symbol;
        const group=chain+'/'+asset.id,total=totals.get(group)||{n:0n,decimals:asset.decimals,title:c.name+' '+asset.symbol+(asset.id?' ['+asset.id+']':'')};
        total.n+=BigInt(asset.amount);totals.set(group,total);
        if(asset.transferable&&BigInt(asset.amount)>0n){
          visible.push([id,item]);const label=check(display,chosen.has(id),v=>{if(v)chosen.set(id,item);else chosen.delete(id);selection();});row.append(label);
        }else row.append(make('span',display+(asset.transferable?'':' · view only')));
        if(asset.id)row.append(make('code',asset.id));
      }
    }
    root.append(row);
  }
  if(!root.children.length)root.append(make('p',accounts.length?'No accounts match these filters.':'Import or connect a public account to begin.'));
  $('totals').textContent=[...totals.values()].filter(t=>t.n>0n).map(t=>units(t.n,t.decimals)+' '+t.title).join(' · ');
  selection();
}
async function load(){
  const d=await chrome.storage.local.get(null);accounts=d.accounts||[];tracked=d.tracked||{};drawTracked();history=d.history||[];records=Object.fromEntries(Object.entries(d).filter(([k])=>k.startsWith('scan:')));
  $('known').replaceChildren(...accounts.map(a=>new Option(a.labels.join(' / '),a.address)));
  $('importBox').open=!accounts.length;render();activity();
}
function activity(){
  const root=$('activity');root.replaceChildren();
  if(!history.length)root.append(make('p','No transfers recorded.'));
  for(const h of history){
    const el=make('article');el.append(make('strong',h.status+' · '+h.amount+' '+h.symbol+' · '+chains[h.chain].name),make('small',new Date(h.time).toLocaleString()),make('code',h.from+' → '+h.to));
    if(h.hash)el.append(make('code',h.hash));if(h.checkError)el.append(make('small',h.checkError));
    if(['Unknown','Awaiting wallet'].includes(h.status)){const b=make('button','Mark independently reviewed');b.onclick=async()=>{if(confirm('Have you checked this account’s transaction history independently? Marking reviewed allows another transfer.'))try{await msg('resolve',{key:h.key});}catch(e){$('notice').textContent=e.message;}};el.append(b);}
    root.append(el);
  }
}
function discovery(){
  const root=$('candidates');root.replaceChildren();
  for(const [addr,v] of candidates)root.append(check('#'+v.index+' · '+addr+' · '+report(v.result),candidateChecks.has(addr),checked=>{if(checked)candidateChecks.add(addr);else candidateChecks.delete(addr);}));
}
async function refresh(jobs,discoveryMode){
  if(controller)throw Error('A scan is already running.');
  const ctl=new AbortController();controller=ctl;$('cancel').hidden=false;
  let index=0,done=0;
  try{
    async function next(){
      while(!ctl.signal.aborted&&index<jobs.length){
        const [chain,owner]=jobs[index++],r=await scan(chain,owner,ctl.signal,tracked[chain]||[]);
        if(discoveryMode){const v=candidates.get(owner);if(v)v.result=r;discovery();}
        else{const k=key(chain,owner);await chrome.storage.local.set({[k]:r});records[k]=r;render();}
        $('progress').textContent='Checked '+(++done)+' of '+jobs.length+' account/network pairs.';
      }
    }
    await Promise.allSettled([next(),next()]).then(results=>{for(const r of results)if(r.status==='rejected'&&!ctl.signal.aborted)throw r.reason;});
  }finally{if(ctl.signal.aborted)$('progress').textContent='Scan stopped after '+done+' checks.';controller=null;$('cancel').hidden=true;}
}
$('network').add(new Option('All networks','all'));
for(const [id,c] of Object.entries(chains)){$('network').add(new Option(c.name,id));if(id!=='sol'){for(const select of ['dchain','tchain'])$(select).add(new Option(c.name,id));}}
function drawTracked(){
  const root=$('tracked');root.replaceChildren();
  for(const token of tracked[$('tchain').value]||[])root.append(make('code',token.symbol+' · '+token.id));
}
$('tchain').onchange=drawTracked;
on('track',async()=>{
  const chain=$('tchain').value,id=address($('contract').value,'evm'),symbol=$('ticker').value.trim()||id.slice(0,10);
  const tokens=tracked[chain]||[];
  tracked={...tracked,[chain]:[...tokens.filter(t=>t.id!==id),{id,symbol}]};
  await chrome.storage.local.set({tracked});drawTracked();$('contract').value='';$('ticker').value='';
});
on('add',async()=>{
  const lines=$('addresses').value.trim().split(/\s+/).filter(Boolean);if(!lines.length)throw Error('Enter public addresses.');
  await msg('import',{items:lines.map(v=>({address:v,family:v.startsWith('0x')?'evm':'sol',label:$('label').value.trim()||'Imported'}))});
  $('addresses').value='';await load();
});
on('derive',()=>{if(controller)throw Error('Finish the active scan first.');const result=discover($('xpub').value);candidates.clear();candidateChecks.clear();for(const v of result)candidates.set(v.address,v);$('xpub').value='';$('discovery').hidden=false;discovery();});
on('dscan',()=>refresh([...candidates.keys()].map(a=>[$('dchain').value,a]),true));
$('dchain').onchange=()=>{controller?.abort();for(const v of candidates.values())delete v.result;candidateChecks.clear();discovery();};
on('dused',()=>{candidateChecks.clear();for(const [a,v] of candidates)if(v.result?.used)candidateChecks.add(a);discovery();});
on('dall',()=>{for(const a of candidates.keys())candidateChecks.add(a);discovery();});
on('dimport',async()=>{if(!candidateChecks.size)throw Error('Select candidate addresses first.');
  await msg('import',{items:[...candidateChecks].map(a=>({address:a,family:'evm',label:($('label').value.trim()||'Derived')+' #'+candidates.get(a).index}))});
  const updates={};for(const a of candidateChecks){const r=candidates.get(a).result;if(r)updates[key(r.chain,a)]=r;}await chrome.storage.local.set(updates);await load();
});
on('scan',()=>{const jobs=[];for(const a of accounts)for(const chain of Object.keys(chains))if((a.family==='sol')===(chain==='sol')&&['all',chain].includes($('network').value))jobs.push([chain,a.address]);if(!jobs.length)throw Error('Import an account on this network first.');return refresh(jobs,false);});
on('cancel',()=>controller?.abort());
for(const id of ['network','hide','used'])$(id).onchange=()=>{chosen.clear();render();};
on('select',()=>{if($('network').value==='all')throw Error('Choose one network first.');for(const [id,item] of visible)chosen.set(id,item);render();});
on('none',()=>{chosen.clear();render();});
$('filter').oninput=()=>{chosen.clear();render();};
$('amountMode').onchange=()=>{$('fixedLabel').hidden=$('amountMode').value==='sweep';};
on('plan',async()=>{
  const items=[...chosen.values()].sort((a,b)=>Number(!a.id)-Number(!b.id));
  if(!items.length||new Set(items.map(i=>i.chain)).size!==1)throw Error('Select assets on one network.');
  const to=address($('destination').value,items[0].chain==='sol'?'sol':'evm');
  if(items.some(i=>i.owner===to))throw Error('Remove the destination wallet from the selected sources.');
  let batch=items;
  if($('amountMode').value==='fixed'){
    if(new Set(items.map(i=>i.id)).size!==1)throw Error('Select the same asset across source wallets for a fixed-amount transfer.');
    const fixed=$('fixed').value.trim();rawAmount(fixed,items[0].decimals);
    batch=items.map(item=>({...item,fixed}));
  }
  await msg('transfer',{items:batch,destination:to});
});
on('connect',()=>msg('connect'));on('check',async()=>{await msg('status');await load();});
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&(changes.accounts||changes.history))load();});
load().catch(e=>$('notice').textContent=e.message);
