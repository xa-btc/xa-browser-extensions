import {chains,address} from './model.js';
export const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',TOKEN22='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
async function json(url,options={}){
  const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000);
  const request={...options,signal,credentials:'omit',referrerPolicy:'no-referrer'};
  let response=await fetch(url,request);
  if(response.status===429){
    const seconds=Math.min(8,Math.max(1,Number(response.headers.get('Retry-After'))||2));
    await new Promise(resolve=>setTimeout(resolve,seconds*1000));signal.throwIfAborted();
    response=await fetch(url,request);
  }
  if(!response.ok)throw Error('HTTP '+response.status+' from '+new URL(url).hostname);
  return JSON.parse(await response.text(),(key,v,ctx)=>typeof v==='number'&&Number.isInteger(v)&&!Number.isSafeInteger(v)?ctx.source:v);
}
export async function rpc(chain,method,params,signal){
  const r=await json(chains[chain].rpc,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal});
  if(r.error||r.result===undefined)throw Error(r.error?.message||'Invalid RPC response');return r.result;
}
const usdc={
  eth:'0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  base:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  arb:'0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  polygon:'0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'
};
export async function scan(chain,owner,signal,tracked=[]){
  const c=chains[chain],errors=[],assets=[];
  let native=null,used=false;
  async function check(work){try{await work();}catch(e){if(signal?.aborted)throw e;errors.push(e.message);}}
  if(chain==='sol'){
    await check(async()=>{native=BigInt((await rpc(chain,'getBalance',[owner,{commitment:'confirmed'}],signal)).value).toString();});
    const tokenAccounts=[];
    for(const programId of [TOKEN,TOKEN22])await check(async()=>{
      const result=await rpc(chain,'getTokenAccountsByOwner',[owner,{programId},{encoding:'jsonParsed',commitment:'confirmed'}],signal);
      for(const row of result.value){
        const info=row.account.data.parsed.info,amt=info.tokenAmount;
        tokenAccounts.push(row.pubkey);
        if(BigInt(amt.amount)>0n)assets.push({symbol:info.mint.slice(0,8)+'…',id:info.mint,account:row.pubkey,amount:amt.amount,decimals:amt.decimals,transferable:programId===TOKEN&&info.state==='initialized'});
      }
    });
    await check(async()=>{
      for(const key of [owner,...tokenAccounts]){
        if((await rpc(chain,'getSignaturesForAddress',[key,{limit:1}],signal)).length){used=true;break;}
      }
    });
  }else{
    await check(async()=>{native=BigInt(await rpc(chain,'eth_getBalance',[owner,'latest'],signal)).toString();});
    await check(async()=>{used=BigInt(await rpc(chain,'eth_getTransactionCount',[owner,'latest'],signal))>0n;});
    const prefix=c.index+'/api/v2/addresses/'+owner;
    let indexed=false;
    await check(async()=>{
      const rows=await json(prefix+'/token-balances',{signal});if(!Array.isArray(rows))throw Error('Token index unavailable');
      for(const row of rows){
        if(row.token?.type!=='ERC-20'||BigInt(row.value)<=0n)continue;
        const decimals=Number(row.token.decimals);if(row.token.decimals==null||!Number.isInteger(decimals)||decimals<0||decimals>255){errors.push('Missing token decimals');continue;}
        assets.push({symbol:row.token.symbol||'ERC-20',id:address(row.token.address_hash||row.token.address,'evm'),amount:row.value,decimals,transferable:true});
      }
      indexed=true;
    });
    const contracts=new Map(tracked.map(t=>[t.id.toLowerCase(),t]));
    if(!indexed)contracts.set(usdc[chain],{id:usdc[chain],symbol:'USDC'});
    for(const token of contracts.values())await check(async()=>{
      const id=address(token.id,'evm');
      if(assets.some(asset=>asset.id===id))return;
      const read=data=>rpc(chain,'eth_call',[{to:id,data},'latest'],signal);
      const balance=BigInt(await read('0x70a08231'+owner.slice(2).padStart(64,'0')));
      if(!balance)return;
      const decimals=Number(BigInt(await read('0x313ce567')));
      if(!Number.isInteger(decimals)||decimals<0||decimals>255)throw Error('Invalid token decimals: '+id);
      assets.push({symbol:token.symbol,id,decimals,amount:balance.toString(),transferable:true});
    });
    if(!used)await check(async()=>{
      const r=await json(prefix,{signal});
      if(typeof r.has_token_transfers!=='boolean')throw Error('Transfer history unavailable');
      used=r.has_token_transfers||r.has_logs===true||r.has_beacon_chain_withdrawals===true;
      for(const route of ['transactions','internal-transactions']){
        if(used)break;
        const page=await json(prefix+'/'+route,{signal});
        if(!Array.isArray(page.items))throw Error('Native transfer history unavailable.');
        used=page.items.length>0;
      }
    });
  }
  const funded=(native!==null&&BigInt(native)>0n)||assets.length>0;
  return {owner,chain,native,assets,errors,used:used||funded,funded,time:Date.now()};
}
