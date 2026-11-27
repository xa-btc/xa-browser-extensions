'use strict';
const $=id=>document.getElementById(id);
let tab,preference,signature;
async function refresh(){
  const state=await chrome.tabs.sendMessage(tab.id,{op:'status'}).catch(()=>null);
  const ladder=state?.ladder||[];
  $('actual').textContent=state?.height?state.width+' × '+state.height:state?'Waiting for video':'Open a Paramount+ video';
  $('reload').disabled=!state;
  const key=JSON.stringify([ladder,preference]);
  if(key!==signature){
    signature=key;
    const choices=[new Option('Auto (adaptive)','auto'),new Option('Highest available','max')];
    for(const [height,bits] of ladder)choices.push(new Option(height+'p'+(bits?' · up to '+(bits/1000000).toFixed(2)+' Mbps':''),String(height)));
    if(!choices.some(o=>o.value===preference))choices.push(new Option(preference+'p (saved)',preference));
    $('mode').replaceChildren(...choices);$('mode').value=preference;
    $('available').textContent=ladder.length?ladder.map(([h])=>h+'p').join(' · '):'No quality list detected yet';
  }
}
(async()=>{
  [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  preference=(await chrome.storage.local.get({mode:'auto'})).mode;
  await refresh();setInterval(refresh,1000);
})().catch(e=>{$('note').textContent=e.message;});
$('mode').onchange=async()=>{
  preference=$('mode').value;await chrome.storage.local.set({mode:preference});await refresh();
  $('note').textContent='Saved. Reload the player to apply this choice to the current stream.';
};
$('reload').onclick=async()=>{await chrome.tabs.reload(tab.id);window.close();};
