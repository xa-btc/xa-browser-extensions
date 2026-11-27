'use strict';
const $=id=>document.getElementById(id);
settings().then(p=>{
  for(const key of Object.keys(defaults)){if(key==='max')$(key).value=p.max;else $(key).checked=p[key];}
  document.documentElement.classList.toggle('dark',p.dark);
});
$('options').onsubmit=async e=>{
  e.preventDefault();
  const value={max:Number($('max').value)};
  for(const key of ['dark','hideTips','resetOnNavigation'])value[key]=$(key).checked;
  await chrome.storage.local.set(value);document.documentElement.classList.toggle('dark',value.dark);
  $('status').textContent='Settings saved.';
};
