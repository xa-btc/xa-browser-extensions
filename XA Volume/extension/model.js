'use strict';
const defaults={max:300,dark:true,resetOnNavigation:false,hideTips:false};
const settings=()=>chrome.storage.local.get(defaults);
function stepVolume(value,direction,fine=false){
  if(fine||value<10||(value===10&&direction<0))return value+direction;
  return direction>0?(Math.floor(value/10)+1)*10:(Math.ceil(value/10)-1)*10;
}
function sliderValue(pos){return pos<=10?pos:10+(pos-10)*10;}
function sliderPosition(value){return value<=10?value:10+(value-10)/10;}
