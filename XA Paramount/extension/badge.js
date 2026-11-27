chrome.runtime.onMessage.addListener((m,s)=>{
  if(s.tab?.id!=null&&Number.isInteger(m.height)&&m.height>=0&&m.height<32768)
    chrome.action.setBadgeText({tabId:s.tab.id,text:m.height?String(m.height):''}).catch(()=>{});
});
