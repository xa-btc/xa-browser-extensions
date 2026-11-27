import {merge} from './model.js';
import {quote} from './quote.js';
import {rpc} from './network.js';
import {base58} from '@scure/base';
const origin='http://127.0.0.1:43179';
let serial=Promise.resolve();
function enqueue(f){const result=serial.then(f);serial=result.catch(()=>{});return result;}
async function data(){return chrome.storage.local.get({accounts:[],history:[]});}
async function begin(mode,items=[],destination=''){
  const {session}=await chrome.storage.session.get('session');
  if(session){try{await chrome.tabs.get(session.tab);throw Error('Finish or close the other wallet connection tab first.');}catch(e){if(!e.message.includes('No tab with id'))throw e;}}
  const tab=await chrome.tabs.create({url:'about:blank'}),nonce=crypto.randomUUID();
  await chrome.storage.session.set({session:{mode,items,destination,tab:tab.id,nonce,expires:Date.now()+3600000}});
  await chrome.tabs.update(tab.id,{url:origin+'/#'+chrome.runtime.id+'/'+nonce});
}
async function reconcile(){
  const {history}=await data();
  for(const row of history.filter(h=>h.status==='Submitted')){
    try{
      if(row.chain==='sol'){
        const r=(await rpc('sol','getSignatureStatuses',[[row.hash],{searchTransactionHistory:true}])).value[0];
        if(r?.err)row.status='Failed';
        else if(['confirmed','finalized'].includes(r?.confirmationStatus))row.status='Confirmed';
      }else{
        const r=await rpc(row.chain,'eth_getTransactionReceipt',[row.hash]);
        if(r)row.status=BigInt(r.status)===1n?'Confirmed':'Failed';
      }
      delete row.checkError;
    }catch(e){row.checkError=e.message;}
  }
  await chrome.storage.local.set({history});return history;
}
async function internal(m){
  if(m.op==='import'){
    const {accounts}=await data();
    await chrome.storage.local.set({accounts:merge(accounts,m.items)});return {};
  }
  if(m.op==='connect'||m.op==='transfer'){await begin(m.op,m.items,m.destination);return {};}
  if(m.op==='status'){await reconcile();return {};}
  if(m.op==='resolve'){
    const {history}=await data(),row=history.find(h=>h.key===m.key);
    if(row?.status!=='Unknown'&&row?.status!=='Awaiting wallet')throw Error('This row cannot be marked reviewed.');
    const {session}=await chrome.storage.session.get('session');
    if(session?.busy===m.key)throw Error('Finish or close the active signing window first.');
    row.status='Manually reviewed';await chrome.storage.local.set({history});return {};
  }
  throw Error('Unknown operation.');
}
async function external(m,sender){
  const {session:s}=await chrome.storage.session.get('session');
  if(!s||sender.origin!==origin||sender.url?.split('#')[0]!==origin+'/'||sender.frameId!==0||sender.tab?.id!==s.tab||m.nonce!==s.nonce||s.expires<Date.now())throw Error('Open a fresh connection from XA Wallet Maintainer.');
  if(m.op==='info')return {mode:s.mode,items:s.items,destination:s.destination};
  if(m.op==='accounts'&&s.mode==='connect'){
    await internal({op:'import',items:m.accounts});return {};
  }
  if(s.mode!=='transfer')throw Error('No transfer batch is open.');
  const item=s.items[m.index];if(!item)throw Error('Unknown transfer.');
  const {history}=await data();
  const pending=history.find(h=>h.from===item.owner&&h.chain===item.chain&&['Awaiting wallet','Unknown','Submitted'].includes(h.status));
  if(m.op==='preview'){
    if(pending)throw Error('A prior transaction from this account is pending. Check activity before continuing.');
    if(s.done?.includes(m.index))throw Error('Already submitted.');
    const q=await quote(item,s.destination);
    s.preview={index:m.index,...q};await chrome.storage.session.set({session:s});return q;
  }
  if(m.op==='authorize'){
    if(pending||s.busy||s.done?.includes(m.index)||s.preview?.index!==m.index||s.preview.expires<Date.now())throw Error('Refresh the preview before signing.');
    const key=crypto.randomUUID(),{tx,...summary}=s.preview;
    s.busy=key;s.busyIndex=m.index;s.preview=null;
    await chrome.storage.local.set({history:[{...summary,key,time:Date.now(),status:'Awaiting wallet'},...history]});
    await chrome.storage.session.set({session:s});return {key,tx};
  }
  if(m.op==='result'&&s.busy===m.key&&s.busyIndex===m.index){
    const row=history.find(h=>h.key===m.key);if(!row)throw Error('Transfer record missing.');
    let valid=false;
    try{valid=item.chain==='sol'?base58.decode(m.hash||'').length===64:/^0x[\da-f]{64}$/i.test(m.hash||'');}catch{}
    row.status=valid?'Submitted':m.rejected?'Rejected':'Unknown';
    if(valid){row.hash=m.hash;s.done=[...(s.done||[]),m.index];}
    s.busy=null;delete s.busyIndex;await chrome.storage.local.set({history});await chrome.storage.session.set({session:s});return {};
  }
  if(m.op==='status'){await reconcile();return {};}
  throw Error('Invalid transfer state.');
}
function answer(work,reply){enqueue(work).then(reply,e=>reply({error:e.message}));return true;}
chrome.runtime.onMessage.addListener((m,s,reply)=>{
  if(s.id===chrome.runtime.id&&s.url?.startsWith(chrome.runtime.getURL('')))return answer(()=>internal(m),reply);
});
chrome.runtime.onMessageExternal.addListener((m,s,reply)=>answer(()=>external(m,s),reply));
chrome.tabs.onRemoved.addListener(id=>enqueue(async()=>{
  const {session}=await chrome.storage.session.get('session');if(session?.tab!==id)return;
  if(session.busy){
    const {history}=await data(),row=history.find(h=>h.key===session.busy);
    if(row?.status==='Awaiting wallet'){row.status='Unknown';await chrome.storage.local.set({history});}
  }
  await chrome.storage.session.remove('session');
}));
chrome.action.onClicked.addListener(()=>chrome.tabs.create({url:chrome.runtime.getURL('dashboard.html')}));
