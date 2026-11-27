import {getWallets} from '@wallet-standard/app';
import {base58} from '@scure/base';
import {address,chains,units} from './model.js';
const $=id=>document.getElementById(id),make=(tag,text)=>{const e=document.createElement(tag);e.textContent=text;return e;};
const [ext,nonce]=location.hash.slice(1).split('/');
let batch,connected=null,preview=null,busy=false;
const wallets=new Map(),registry=getWallets();
let manualChoice=false;
function preferWallet(){
  if(!batch||manualChoice||connected||busy)return;
  const options=[...wallets.entries()];
  const family=batch.mode==='transfer'?(batch.items[0]?.chain==='sol'?'sol':'evm'):null;
  const preferred=family?options.find(([,w])=>w.family===family):options.find(([,w])=>w.family==='sol'&&/phantom/i.test(w.label));
  if(preferred)$('wallet').value=preferred[0];
  else if(options.some(([,w])=>/phantom/i.test(w.label)))$('wallet').value='';
  else if(options.length)$('wallet').value=options[0][0];
}
function addWallet(provider,label,family,injected=false){
  if(!provider||[...wallets.values()].some(w=>w.provider===provider&&w.family===family))return;
  if(!injected&&family==='sol'&&/phantom/i.test(label)){
    const fallback=[...wallets.entries()].find(([,w])=>w.injected);
    if(fallback){wallets.set(fallback[0],{provider,label,family,injected:false});preferWallet();return;}
  }
  const key=String(wallets.size);wallets.set(key,{provider,label,family,injected});$('wallet').add(new Option(label+' · '+(family==='sol'?'Solana':'EVM'),key));preferWallet();
}
addEventListener('eip6963:announceProvider',e=>{if(e.detail?.provider?.request)addWallet(e.detail.provider,e.detail.info.name,'evm');});
function find(){
  dispatchEvent(new Event('eip6963:requestProvider'));
  for(const w of registry.get())if(w.features['standard:connect']&&w.chains.includes('solana:mainnet'))addWallet(w,w.name,'sol');
  const phantom=window.phantom?.solana||(window.solana?.isPhantom?window.solana:null);
  if(batch?.mode==='connect'&&phantom?.connect&&![...wallets.values()].some(w=>w.family==='sol'&&/phantom/i.test(w.label)))addWallet(phantom,'Phantom','sol',true);
  for(const p of window.ethereum?.providers||[window.ethereum])if(p?.request)addWallet(p,p.isRabby?'Rabby':p.isCoinbaseWallet?'Coinbase Wallet':p.isPhantom?'Phantom':p.isMetaMask?'MetaMask':'Browser wallet','evm');
}
registry.on('register',find);
window.addEventListener('phantom#initialized',find);
async function send(op,extra={}){
  if(ext!==XW_EXTENSION_ID||!nonce||!globalThis.chrome?.runtime?.sendMessage)throw Error('Open this connector from XA Wallet Maintainer in Brave.');
  const r=await chrome.runtime.sendMessage(ext,{op,nonce,...extra});if(!r||r.error)throw Error(r?.error||'Extension is unavailable.');return r;
}
function clearQuote(){preview=null;$('quote').replaceChildren();$('sign').hidden=true;}
function handle(id,fn){$(id).onclick=async()=>{if(busy)return;busy=true;
  try{$('notice').textContent='';await fn();}catch(e){$('notice').textContent=e.message;}finally{busy=false;}
};}
$('wallet').onchange=()=>{manualChoice=true;connected=null;$('accounts').replaceChildren();$('import').hidden=true;clearQuote();};$('item').onchange=clearQuote;
handle('find',find);
handle('connect',async()=>{
  const w=wallets.get($('wallet').value);if(!w)throw Error('Select a network. For a Solana-only Phantom account, select Phantom · Solana. If it is missing, unlock Phantom and click Find wallets.');
  let accounts;
  if(w.injected){
    const result=await w.provider.connect();
    const key=result?.publicKey||w.provider.publicKey;
    accounts=key?[key.toString()]:[];
  }else if(w.family==='sol')accounts=(await w.provider.features['standard:connect'].connect()).accounts.filter(a=>a.chains.includes('solana:mainnet')).map(a=>a.address);
  else accounts=await w.provider.request({method:'eth_requestAccounts'});
  if(!accounts.length)throw Error('Wallet shared no accounts.');
  connected={...w,accounts:accounts.map(a=>address(a,w.family))};$('accounts').replaceChildren(...connected.accounts.map(a=>make('code',a)));
  $('import').hidden=batch.mode!=='connect';clearQuote();
});
handle('import',async()=>{await send('accounts',{accounts:connected.accounts.map(a=>({address:a,family:connected.family,label:connected.label}))});$('notice').textContent='Connected addresses imported into your portfolio.';});
handle('check',async()=>{await send('status');$('notice').textContent='Confirmation status refreshed. Preview the next transfer when ready.';});
handle('preview',async()=>{
  clearQuote();const index=Number($('item').value),q=await send('preview',{index});
  preview={index,...q};
  const root=$('quote');
  for(const [label,v] of [['Network',chains[q.chain].name],['From',q.from],['To',q.to],['Asset',q.asset||chains[q.chain].coin],['Amount',q.amount+' '+q.symbol],['Fee reserve',q.fee+' '+chains[q.chain].coin],['Recipient account rent',q.rent+' '+chains[q.chain].coin]]){
    if(label==='Recipient account rent'&&q.rent==='0')continue;
    root.append(make('small',label),make('code',v));
  }
  $('sign').hidden=false;
});
handle('sign',async()=>{
  const q=preview,w=connected;
  if(!q||q.expires<=Date.now()){clearQuote();throw Error('Preview expired. Request a new quote.');}
  if(!w||!w.accounts.includes(q.from)||(q.chain==='sol')!==(w.family==='sol'))throw Error('Connect the wallet sharing the exact source address shown above.');
  let account,feature;
  if(w.family==='evm'){
    const chainId='0x'+chains[q.chain].id.toString(16);
    if(BigInt(await w.provider.request({method:'eth_chainId'}))!==BigInt(chainId))await w.provider.request({method:'wallet_switchEthereumChain',params:[{chainId}]});
    const shared=await w.provider.request({method:'eth_accounts'});
    if(BigInt(await w.provider.request({method:'eth_chainId'}))!==BigInt(chainId)||!shared.some(a=>address(a,'evm')===q.from))throw Error('Wallet network or source account changed.');
  }else{
    account=w.provider.accounts.find(a=>a.address===q.from&&a.chains.includes('solana:mainnet'));
    feature=w.provider.features['solana:signAndSendTransaction'];
    if(!feature||!account)throw Error('This wallet does not offer Solana mainnet signing for the source.');
  }
  const {key,tx}=await send('authorize',{index:q.index});clearQuote();
  let hash='',failure;
  try{
    if(w.family==='evm')hash=await w.provider.request({method:'eth_sendTransaction',params:[{...tx,chainId:'0x'+chains[q.chain].id.toString(16)}]});
    else{
      const bytes=Uint8Array.from(atob(tx),c=>c.charCodeAt(0));
      const [result]=await feature.signAndSendTransaction({account,chain:'solana:mainnet',transaction:bytes});
      hash=base58.encode(result.signature);
    }
  }catch(e){failure=e;}
  await send('result',{key,index:q.index,hash,rejected:failure?.code===4001});
  if(failure)throw Error(failure.message+' Check transaction activity before retrying.');
  $('notice').textContent='Submitted: '+hash;
  const option=$('item').options[q.index];option.disabled=true;
  const next=[...$('item').options].find(o=>!o.disabled);if(next)$('item').value=next.value;
});
(async()=>{
  batch=await send('info');find();preferWallet();setTimeout(find,750);$('status').textContent=batch.mode==='connect'?'Select a wallet to import its shared public addresses.':'Review and authorize each source transaction individually.';
  if(batch.mode==='transfer'){
    $('batch').hidden=false;$('destination').textContent=batch.destination;
    batch.items.forEach((item,i)=>$('item').add(new Option(chains[item.chain].name+' · '+(item.fixed||units(item.amount,item.decimals))+' '+item.symbol+' · '+item.owner,String(i))));
  }
})().catch(e=>{$('notice').textContent=e.message;});
