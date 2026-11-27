'use strict';
const $=id=>document.getElementById(id);
const form=$('preferences'),status=$('status');
$('unavailable').hidden=location.hash!=='#unavailable';
const sections={
  search:[
    ['caseSensitive','Match letter case'],['accents','Match accents'],['wild','Use wildcards'],['single','Include single-character searches'],
    ['position','Default match',XT.locations],['separator','Alternative separator','text'],['fields','Search text inputs and textareas'],['editable','Search editable page content']
  ],
  display:[
    ['theme','Theme',['system','dark','light']],['visibility','Highlight visibility',{always:'Always',panel:'While panel is open',never:'Off'}],
    ['style','Highlight style',{solid:'Solid',glow:'Glow',none:'Count only'}],['bright','Bright highlights'],['marks','Clickable page markers'],
    ['badge','Toolbar count',{nonzero:'When nonzero',always:'Always',off:'Off'}],['markSide','Marker side',['left','right']],['sound','Match notification sound',{off:'Off',chime:'High tone',low:'Low tone'}]
  ],
  panel:[
    ['corner','Default corner',['top-right','top-left','bottom-right','bottom-left']],['opacity','Opacity (%)','number'],['pinned','Keep panel open on outside click'],
    ['opening','On open',{preserve:'Preserve selection',new:'New entry line',all:'Select all'}],['context','Selection context menu',{none:'Off',basic:'Add selection',advanced:'Selection and similar elements'}]
  ],
  sites:[['policy','Apply rules',{block:'Block listed addresses',allow:'Allow listed addresses only'}]]
};
const controls={navigation:'Previous and next buttons',counter:'Total count',termNav:'Per-term navigation',parameters:'Per-term settings',listTools:'List tools',controls:'Search controls',help:'Help',expressions:'Results list',flash:'Flash',close:'Close',pin:'Pin',theme:'Theme',settings:'Settings',caseSensitive:'Case',accents:'Accents',wild:'Wildcards',bright:'Bright highlights',marks:'Page markers',visibility:'Highlights'};
const el=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};
for(const [section,specs] of Object.entries(sections))for(const [key,title,type] of specs){
  const label=el('label',title);let input;
  if(typeof type==='object'){
    input=el('select');for(const [value,name] of Array.isArray(type)?type.map(x=>[x,x]):Object.entries(type)){
      const option=el('option',name);option.value=value;input.append(option);}
  }else{input=el('input');input.type=type||'checkbox';if(key==='opacity'){input.min=35;input.max=100;input.required=true;}if(key==='separator'){input.maxLength=32;input.required=true;}}
  input.name=key;label.append(input);$(section).append(label);
}
for(const [key,title] of Object.entries(controls)){
  const label=el('label',title),input=el('input');input.type='checkbox';input.dataset.control=key;label.append(input);$('controls').append(label);
}
let palette;
function showPalette(){
  $('palette').replaceChildren();
  for(let i=0;i<palette.light.length;i++){
    const row=el('div');row.className='colors';row.append(el('strong',String(i+1)));
    for(const [key,name] of [['light','Light'],['lightInk','Text'],['dark','Dark'],['darkInk','Text']]){
      const label=el('label',name),input=el('input');input.type='color';input.value=palette[key][i];input.oninput=()=>palette[key][i]=input.value;
      label.append(input);row.append(label);
    }
    const remove=el('button','Remove');remove.type='button';remove.disabled=palette.light.length===1;
    remove.onclick=()=>{for(const a of Object.values(palette))a.splice(i,1);showPalette();};row.append(remove);$('palette').append(row);
  }
  $('add').disabled=palette.light.length>=20;
}
function populate(settings){
  for(const field of form.elements){
    if(field.dataset.control)field.checked=!settings.hidden.includes(field.dataset.control);
    else if(field.name){if(field.type==='checkbox')field.checked=settings[field.name];else field.value=settings[field.name];}
  }
  palette=XT.palette(settings);showPalette();
}
$('add').onclick=()=>{for(const key of Object.keys(palette))palette[key].push(palette[key][0]);showPalette();};
$('defaultPalette').onclick=()=>{palette=XT.palette(XT.defaults);showPalette();};
$('load').onclick=()=>$('paletteFile').click();
$('paletteFile').onchange=async e=>{try{palette=XT.palette(JSON.parse(await e.target.files[0].text()));showPalette();status.textContent='Palette imported. Save settings to apply it.';}catch(error){status.textContent=error.message;}finally{e.target.value='';}};
$('save').onclick=()=>{
  const output={};for(const theme of ['light','dark']) output[theme]=palette[theme].map((back,i)=>({back,front:palette[theme+'Ink'][i]}));
  const link=el('a');link.href=URL.createObjectURL(new Blob([JSON.stringify(output,null,2)],{type:'application/json'}));link.download='XA search palette.json';link.click();
  setTimeout(()=>URL.revokeObjectURL(link.href),1000);
};
$('defaults').onclick=()=>populate(XT.defaults);
form.onsubmit=async e=>{
  e.preventDefault();const settings={...palette,hidden:[]};
  for(const field of form.elements){
    if(field.dataset.control){if(!field.checked)settings.hidden.push(field.dataset.control);}
    else if(field.name)settings[field.name]=field.type==='checkbox'?field.checked:field.type==='number'?Number(field.value):field.value;
  }
  try{await chrome.storage.local.set({settings});status.textContent='Settings saved.';}catch(error){status.textContent=error.message;}
};
chrome.storage.local.get('settings').then(({settings})=>populate({...XT.defaults,...settings}));

