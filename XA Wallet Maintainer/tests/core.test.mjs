import test from 'node:test';
import assert from 'node:assert/strict';
import {HDKey} from '@scure/bip32';
import {keccak_256} from '@noble/hashes/sha3';
import {base58} from '@scure/base';
import {discover,checksum,merge,units} from '../src/model.js';
import {quote} from '../src/quote.js';
import {scan,TOKEN} from '../src/network.js';
const alice='0x1111111111111111111111111111111111111111',bob='0x2222222222222222222222222222222222222222';
test('public derivation matches independent private branches for first and hundredth addresses',()=>{
  const node=HDKey.fromMasterSeed(Uint8Array.from({length:32},(_,i)=>i)).derive("m/44'/60'/0'");
  const children=discover(node.publicExtendedKey);
  assert.equal(children.length,100);assert.equal(new Set(children.map(x=>x.address)).size,100);
  for(const i of [0,99]){
    const key=node.deriveChild(0).deriveChild(i).privateKey;
    // Node crypto independently obtains the uncompressed public point.
    const ec=createECDH('secp256k1');ec.setPrivateKey(key);
    assert.equal(children[i].address,checksum('0x'+Buffer.from(keccak_256(ec.getPublicKey().slice(1)).slice(-20)).toString('hex')));
  }
  assert.deepEqual(discover(node.deriveChild(0).publicExtendedKey),children);
  assert.throws(()=>discover(node.privateExtendedKey),/public key/);
});
import {createECDH} from 'node:crypto';
test('deduplicates shared EVM accounts and preserves exact integer quantities',()=>{
  const accounts=merge([],[{family:'evm',address:alice,label:'MetaMask'},{family:'evm',address:alice,label:'Rabby'}]);
  assert.equal(accounts.length,1);assert.deepEqual(accounts[0].labels,['MetaMask','Rabby']);
  assert.equal(units('12345678901234567890123',18),'12345.678901234567890123');
});
test('native quote reserves bounded gas and blocks a different network or self-send',async()=>{
  const item={chain:'eth',owner:alice,decimals:18,symbol:'ETH'};
  const responses={eth_chainId:'0x1',eth_getBalance:'0xde0b6b3a7640000',eth_gasPrice:'0x3b9aca00',eth_getCode:'0x',eth_estimateGas:'0x5208'};
  const q=await quote(item,bob,async(_,m)=>responses[m]);
  assert.equal(BigInt(q.tx.value)+BigInt(q.tx.gas)*BigInt(q.tx.gasPrice),10n**18n);
  assert.equal(q.tx.from,alice);assert.equal(q.tx.to,bob);
  await assert.rejects(quote(item,alice),/different/);
  await assert.rejects(quote(item,bob,async()=> '0x2'),/different chain/);
});
test('ERC-20 uses live amount, correct recipient and rejects false-returning tokens',async()=>{
  const token='0x3333333333333333333333333333333333333333',item={chain:'eth',owner:alice,id:token,decimals:6,symbol:'TEST',amount:'1'};
  let fail=false;
  const mock=async(_,method,p)=>{
    if(method==='eth_call'){
      if(p[0].data==='0x313ce567')return '0x6';
      if(p[0].data.startsWith('0x70a08231'))return '0xf4240';
      return fail?'0x0':'0x1';
    }
    return ({eth_chainId:'0x1',eth_getBalance:'0x1000000000',eth_gasPrice:'0x5',eth_estimateGas:'0xf000'})[method];
  };
  const q=await quote(item,bob,mock);
  assert.equal(q.amount,'1');assert.equal(q.tx.to,token);
  assert.equal(q.tx.data,'0xa9059cbb'+bob.slice(2).padStart(64,'0')+'f4240'.padStart(64,'0'));
  fail=true;await assert.rejects(quote(item,bob,mock),/simulation/);
});
test('Solana native and classic SPL build simulatable unsigned messages and reserve ATA rent',async()=>{
  const pk=n=>base58.encode(Uint8Array.from({length:32},(_,i)=>n+i));
  const owner=pk(1),dest=pk(8),mint=pk(20),source=pk(50);
  let sawSimulation=0;
  const mock=async(_,method,p)=>{
    if(method==='getAccountInfo')return {value:p[0]===source?{owner:TOKEN,data:{parsed:{info:{owner,mint,state:'initialized',tokenAmount:{amount:'500',decimals:2}}}}}:null};
    if(method==='simulateTransaction'){
      assert.ok(Buffer.from(p[0],'base64').length>100);sawSimulation++;return {value:{err:null}};
    }
    return {getGenesisHash:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',getBalance:{value:10000000},getLatestBlockhash:{value:{blockhash:pk(90),lastValidBlockHeight:102}},getFeeForMessage:{value:5000},getMinimumBalanceForRentExemption:2039280}[method];
  };
  const native=await quote({chain:'sol',owner,symbol:'SOL',decimals:9},dest,mock);
  assert.equal(native.amount,'0.009995');
  const token=await quote({chain:'sol',owner,symbol:'TEST',decimals:2,id:mint,account:source},dest,mock);
  assert.equal(token.rent,'0.00203928');assert.equal(token.amount,'5');assert.equal(sawSimulation,2);
});

test('fixed transfers preserve smallest units and reject excessive amounts',async()=>{
  const responses={eth_chainId:'0x1',eth_getBalance:'0xde0b6b3a7640000',eth_gasPrice:'0x3b9aca00',eth_getCode:'0x',eth_estimateGas:'0x5208'};
  const mock=async(_,method)=>responses[method];
  const item={chain:'eth',owner:alice,symbol:'ETH',decimals:18,fixed:'0.100000000000000001'};
  assert.equal(BigInt((await quote(item,bob,mock)).tx.value),100000000000000001n);
  await assert.rejects(quote({...item,fixed:'1'},bob,mock),/transferable balance/);
  await assert.rejects(quote({...item,fixed:'0.0000000000000000001'},bob,mock),/precision/);
});
test('partial index response still reads tracked balances and reports incomplete coverage',async t=>{
  t.mock.method(globalThis,'fetch',async (url,opts)=>{
    if(url.includes('blockscout'))return new Response('',{status:403});
    const {method,params}=JSON.parse(opts.body);
    const result=method==='eth_call'?(params[0].data==='0x313ce567'?'0x6':'0x7'):'0x0';
    return Response.json({result});
  });
  const r=await scan('base',alice);
  assert.equal(r.native,'0');assert.equal(r.funded,true);
  assert.equal(r.assets[0].amount,'7');assert.equal(r.assets[0].symbol,'USDC');
  assert.ok(r.errors.length);
});
test('previously used zero-balance accounts remain distinguishable from unchecked history',async t=>{
  t.mock.method(globalThis,'fetch',async (url)=>{
    if(url.endsWith('token-balances'))return Response.json([]);
    if(url.endsWith('internal-transactions'))return Response.json({items:[{}]});
    if(url.endsWith('transactions'))return Response.json({items:[]});
    if(url.includes('blockscout'))return Response.json({has_token_transfers:false});
    return Response.json({result:'0x0'});
  });
  const r=await scan('eth',alice);
  assert.equal(r.funded,false);assert.equal(r.used,true);assert.deepEqual(r.errors,[]);
});
