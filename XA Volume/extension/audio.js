'use strict';
const channels=new Map();
function release(id){
  const ch=channels.get(id);if(!ch)return;
  channels.delete(id);
  for(const track of ch.stream.getTracks())track.stop();
  ch.source.disconnect();ch.gain.disconnect();ch.context.close().catch(()=>{});
}
async function change(m){
  let ch=channels.get(m.id);
  if(!ch){
    if(!m.token)throw Error('Open XV on this tab to start audio control.');
    const stream=await navigator.mediaDevices.getUserMedia({audio:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:m.token}},video:false});
    let context;
    try{
      context=new AudioContext();
      const gain=context.createGain(),source=context.createMediaStreamSource(stream);
      gain.gain.value=m.muted?0:m.volume/100;
      source.connect(gain);gain.connect(context.destination);
      await context.resume();ch={context,gain,source,stream};channels.set(m.id,ch);
      stream.getAudioTracks()[0].onended=()=>{
        if(channels.get(m.id)!==ch)return;
        release(m.id);chrome.runtime.sendMessage({to:'worker',op:'ended',id:m.id}).catch(()=>{});
      };
    }catch(e){stream.getTracks().forEach(t=>t.stop());if(context)await context.close().catch(()=>{});throw e;}
  }
  ch.volume=m.volume;ch.muted=m.muted;
  ch.gain.gain.value=m.muted?0:m.volume/100;
}
chrome.runtime.onMessage.addListener((m,s,reply)=>{
  if(m.to!=='audio'||s.id!==chrome.runtime.id)return;
  (async()=>{
    if(m.op==='apply')await change(m);
    if(m.op==='release')release(m.id);
    return {states:Object.fromEntries([...channels].map(([id,c])=>[id,{volume:c.volume,muted:c.muted}]))};
  })().then(reply,e=>reply({error:e.message}));return true;
});
