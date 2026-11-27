import {address,chains,units,rawAmount} from './model.js';
import {rpc,TOKEN} from './network.js';
import {createTransactionMessage,setTransactionMessageFeePayer,setTransactionMessageLifetimeUsingBlockhash,appendTransactionMessageInstructions,compileTransaction,getTransactionEncoder,createNoopSigner,getBase64Decoder} from '@solana/kit';
import {getTransferSolInstruction} from '@solana-program/system';
import {findAssociatedTokenPda,getCreateAssociatedTokenIdempotentInstruction,getTransferCheckedInstruction} from '@solana-program/token';
const hex=n=>'0x'+n.toString(16);
const word=s=>s.replace(/^0x/,'').toLowerCase().padStart(64,'0');
export async function quote(item,destination,call=rpc){
  const c=chains[item.chain],sol=item.chain==='sol',family=sol?'sol':'evm';
  const from=address(item.owner,family),to=address(destination,family);
  if(from===to||/^0x0{40}$/.test(to)||to==='11111111111111111111111111111111')throw Error('Select a different, nonzero destination wallet.');
  let amount,fee,rent=0n,tx,decimals=item.decimals;
  function quantity(available){
    if(!item.fixed)return available;
    const requested=rawAmount(item.fixed,decimals);
    if(requested>available)throw Error('Requested amount exceeds the transferable balance.');
    return requested;
  }
  if(!sol){
    if(BigInt(await call(item.chain,'eth_chainId',[]))!==BigInt(c.id))throw Error('RPC returned a different chain.');
    const balance=BigInt(await call(item.chain,'eth_getBalance',[from,'pending']));
    const gasPrice=(BigInt(await call(item.chain,'eth_gasPrice',[]))*12n+9n)/10n;
    tx={from,to,gasPrice:hex(gasPrice),value:'0x0'};
    if(item.id){
      const token=address(item.id,family);
      const read=(data)=>call(item.chain,'eth_call',[{to:token,data},'latest']);
      decimals=Number(BigInt(await read('0x313ce567')));
      if(decimals!==item.decimals)throw Error('Token decimals changed. Scan again.');
      amount=quantity(BigInt(await read('0x70a08231'+word(from))));
      tx.to=token;tx.data='0xa9059cbb'+word(to)+word(hex(amount));
      const result=await call(item.chain,'eth_call',[tx,'pending']);
      if(result!=='0x'&&BigInt(result)!==1n)throw Error('Token transfer simulation failed.');
    }
    // Native consolidation is limited to a plain recipient; contracts can require
    // different gas depending on the actual value transferred.
    if(!item.id&&(await call(item.chain,'eth_getCode',[to,'latest']))!=='0x')throw Error('Choose a plain wallet address for a native sweep.');
    const estimate=BigInt(await call(item.chain,'eth_estimateGas',[tx]));
    const gas=(estimate*12n+9n)/10n;tx.gas=hex(gas);fee=gas*gasPrice;
    // Base and Arbitrum can charge L1 data fees. Arbitrum includes them in
    // eth_estimateGas. On Base reserve an additional margin from its L1 fee oracle.
    if(item.chain==='base'){
      const oracle='0x420000000000000000000000000000000000000F';
      const upper=await call(item.chain,'eth_call',[{to:oracle,data:'0xf1c7a58b'+word('200')},'latest']);
      fee+=BigInt(upper)*2n;
    }
    if(balance<=fee)throw Error('Insufficient native balance for the fee reserve.');
    if(!item.id){amount=quantity(balance-fee);tx.value=hex(amount);}
  }else{
    if(await call('sol','getGenesisHash',[])!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')throw Error('Expected Solana mainnet.');
    const signer=createNoopSigner(from),balance=BigInt((await call('sol','getBalance',[from,{commitment:'confirmed'}])).value);
    const receiver=(await call('sol','getAccountInfo',[to,{encoding:'base64',dataSlice:{offset:0,length:0}}])).value;
    if(receiver&&(receiver.executable||receiver.owner!=='11111111111111111111111111111111'))throw Error('Use a destination wallet address rather than a program or token account.');
    const life=(await call('sol','getLatestBlockhash',[{commitment:'confirmed'}])).value;
    let ix=[];
    if(item.id){
      const mint=address(item.id,'sol'),source=address(item.account,'sol');
      const entry=(await call('sol','getAccountInfo',[source,{encoding:'jsonParsed'}])).value;
      const info=entry?.data?.parsed?.info;
      if(entry?.owner!==TOKEN||info.owner!==from||info.mint!==mint||info.state!=='initialized')throw Error('Source token account is unavailable.');
      decimals=info.tokenAmount.decimals;amount=quantity(BigInt(info.tokenAmount.amount));
      const [ata]=await findAssociatedTokenPda({owner:to,tokenProgram:TOKEN,mint});
      const recipient=(await call('sol','getAccountInfo',[ata,{encoding:'base64'}])).value;
      if(!recipient)rent=BigInt(await call('sol','getMinimumBalanceForRentExemption',[165]));
      ix=[getCreateAssociatedTokenIdempotentInstruction({payer:signer,ata,owner:to,mint}),getTransferCheckedInstruction({source,mint,destination:ata,authority:signer,amount,decimals})];
    }
    function build(lamports){
      let m=createTransactionMessage({version:'legacy'});
      m=setTransactionMessageFeePayer(from,m);
      m=setTransactionMessageLifetimeUsingBlockhash({...life,lastValidBlockHeight:BigInt(life.lastValidBlockHeight)},m);
      return compileTransaction(appendTransactionMessageInstructions(item.id?ix:[getTransferSolInstruction({source:signer,destination:to,amount:lamports})],m));
    }
    const b64=getBase64Decoder();
    const rate=(await call('sol','getFeeForMessage',[b64.decode(build(1n).messageBytes),{commitment:'confirmed'}])).value;
    if(rate==null)throw Error('Solana fee quote expired.');
    fee=BigInt(rate);
    if(balance<fee+rent)throw Error('Insufficient SOL for fees and recipient account rent.');
    if(!item.id)amount=quantity(balance-fee);
    if(amount<=0n)throw Error('No transferable balance.');
    tx=b64.decode(getTransactionEncoder().encode(build(amount)));
    const simulation=await call('sol','simulateTransaction',[tx,{encoding:'base64',sigVerify:false,commitment:'confirmed'}]);
    if(simulation.value.err)throw Error('Solana simulation failed: '+JSON.stringify(simulation.value.err));
  }
  if(amount<=0n)throw Error('No transferable balance.');
  return {tx,from,to,chain:item.chain,asset:item.id||'',account:item.account||'',symbol:item.symbol,amount:units(amount,decimals),fee:units(fee,sol?9:18),rent:units(rent,sol?9:18),expires:Date.now()+(sol?45000:90000)};
}
