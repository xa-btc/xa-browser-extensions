'use strict';
const providers={google:'Google · Exact matches',bing:'Bing Visual Search',yandex:'Yandex Images',tineye:'TinEye',baidu:'Baidu Images'};
function webUrl(value){
  try{const u=new URL(value);if(['https:','http:'].includes(u.protocol)&&!u.username&&!u.password)return u.href;}catch{}
  return '';
}
function needsUpload(url){
  if(!url)return true;
  const hostname=new URL(url).hostname.toLowerCase();
  if(hostname.startsWith('['))return /^\[(?:::1\]|f[cd]|fe[89ab])/.test(hostname);
  return !hostname.includes('.')||hostname.endsWith('.local')||hostname.endsWith('.localhost')||
    /^(?:127|10|0)\.|^192\.168\.|^169\.254\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname);
}
function destination(provider,source){
  const bases={google:'https://lens.google.com/uploadbyurl',bing:'https://www.bing.com/images/searchbyimage',yandex:'https://yandex.com/images/search',tineye:'https://tineye.com/search/',baidu:'https://graph.baidu.com/pcpage/index'};
  const params={google:{ep:'ccm',hl:'en',url:source},bing:{cbir:'ssbi',imgurl:source},yandex:source?{rpt:'imageview',url:source}:{},tineye:{url:source},baidu:{tpl_from:'pc'}};
  const url=new URL(bases[provider]);url.search=new URLSearchParams(params[provider]);return url.href;
}
function original(info){
  const link=webUrl(info.linkUrl);
  if(!info.srcUrl)return link;
  if(link&&/\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(new URL(link).pathname))return link;
  return info.srcUrl;
}
function readData(blob){
  return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(blob);});
}
