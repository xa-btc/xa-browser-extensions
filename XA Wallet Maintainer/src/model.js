import {HDKey} from '@scure/bip32';
import {secp256k1} from '@noble/curves/secp256k1';
import {keccak_256} from '@noble/hashes/sha3';
import {bytesToHex} from '@noble/hashes/utils';
import {base58} from '@scure/base';
export const chains={
  eth:{name:'Ethereum',coin:'ETH',id:1,rpc:'https://ethereum-rpc.publicnode.com',index:'https://eth.blockscout.com'},
  base:{name:'Base',coin:'ETH',id:8453,rpc:'https://base-rpc.publicnode.com',index:'https://base.blockscout.com'},
  arb:{name:'Arbitrum One',coin:'ETH',id:42161,rpc:'https://arbitrum-one-rpc.publicnode.com',index:'https://arbitrum.blockscout.com'},
  polygon:{name:'Polygon',coin:'POL',id:137,rpc:'https://polygon-bor-rpc.publicnode.com',index:'https://polygon.blockscout.com'},
  sol:{name:'Solana',coin:'SOL',rpc:'https://api.mainnet-beta.solana.com'}
};
export function checksum(raw){
  const lower=raw.slice(2).toLowerCase(),hash=bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  return '0x'+[...lower].map((v,i)=>parseInt(hash[i],16)>=8?v.toUpperCase():v).join('');
}
export function address(value,family){
  const v=value.trim();
  if(family==='sol'){
    try{if(base58.decode(v).length===32)return v;}catch{}
    throw Error('Expected a Solana public address.');
  }
  if(!/^0x[0-9a-fA-F]{40}$/.test(v))throw Error('Expected an EVM public address.');
  const encoded=checksum(v),body=v.slice(2);
  if(body!==body.toUpperCase()&&body!==body.toLowerCase()&&encoded!==v)throw Error('Invalid EVM address checksum.');
  return encoded;
}
export function discover(xpub){
  if(!xpub.trim().startsWith('xpub'))throw Error('Enter a mainnet extended public key starting with xpub.');
  const key=HDKey.fromExtendedKey(xpub.trim());
  if(![3,4].includes(key.depth))throw Error('Use an account xpub at depth 3 or an external-chain xpub at depth 4.');
  const parent=key.depth===3?key.deriveChild(0):key;
  return Array.from({length:100},(_,i)=>{
    const child=parent.deriveChild(i);
    const point=secp256k1.ProjectivePoint.fromHex(child.publicKey).toRawBytes(false).slice(1);
    return {index:i,address:checksum('0x'+bytesToHex(keccak_256(point).slice(-20)))};
  });
}
export function units(raw,decimals){
  const value=BigInt(raw),scale=10n**BigInt(decimals),fraction=(value%scale).toString().padStart(decimals,'0').replace(/0+$/,'');
  return (value/scale).toString()+(fraction?'.'+fraction:'');
}
export function rawAmount(value,decimals){
  if(!/^\d+(?:\.\d+)?$/.test(value)||value.length>256)throw Error('Enter a positive decimal amount.');
  const [whole,fraction='']=value.split('.');
  if(fraction.length>decimals)throw Error('Amount exceeds the asset’s decimal precision.');
  const n=BigInt(whole+fraction.padEnd(decimals,'0'));
  if(n<=0n)throw Error('Amount must be greater than zero.');
  return n;
}
export function merge(accounts,items){
  const next=accounts.map(a=>({...a,labels:[...a.labels]}));
  for(const item of items){
    const addr=address(item.address,item.family),found=next.find(a=>a.family===item.family&&a.address===addr);
    if(found){if(!found.labels.includes(item.label))found.labels.push(item.label);}
    else next.push({address:addr,family:item.family,labels:[item.label]});
  }
  return next;
}
