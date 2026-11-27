'use strict';
const $=id=>document.getElementById(id);
let selected;
async function message(op,job){
  const response=await chrome.runtime.sendMessage({op,job});if(response?.error&&op!=='get')throw Error(response.error);return response;
}
function populate(){
  for(const [id,label] of Object.entries(providers))$('provider').add(new Option(label,id));
}
function postFile(provider,file,data){
  const targets={google:['https://lens.google.com/v3/upload?ep=ccm&hl=en','encoded_image'],bing:['https://www.bing.com/images/search?view=detailv2&iss=sbiupload&FORM=SBIHMP','imageBin'],tineye:['https://tineye.com/search','image']};
  const [url,name]=targets[provider],form=document.createElement('form'),input=document.createElement('input');
  form.action=url;form.method='post';form.enctype='multipart/form-data';input.name=name;
  if(provider==='bing'){input.type='hidden';input.value=data.slice(data.indexOf(',')+1);}
  else{input.type='file';const transfer=new DataTransfer();transfer.items.add(file);input.files=transfer.files;}
  form.hidden=true;form.append(input);document.body.append(form);form.submit();
}
async function submit(){
  const provider=$('provider').value,url=webUrl($('url').value);
  const file=$('file').files[0]||selected;
  if(!file&&!url)throw Error('Choose an image or enter its HTTP or HTTPS address.');
  if(!file&&needsUpload(url))throw Error('Choose the image file to search an address on your local network.');
  if(file&&url)throw Error('Use one image at a time. Clear the address or the file.');
  if(file&&!file.type.startsWith('image/'))throw Error('Choose an image file.');
  if(file){
    if(['baidu','yandex'].includes(provider)){
      await message('stage',{provider,name:file.name,data:await readData(file)});
      location.replace(destination(provider,''));return;
    }
    if(provider==='google')await message('stage',{provider});else await message('clear');
    postFile(provider,file,provider==='bing'?await readData(file):'');return;
  }
  if(['google','baidu'].includes(provider))await message('stage',{provider,source:url});else await message('clear');
  location.replace(destination(provider,url));
}
function error(e){$('status').textContent=e.message;$('search').querySelector('button').disabled=false;}
async function start(){
  populate();const job=await message('get');
  if(providers[job.provider])$('provider').value=job.provider;
  if(job.error)$('status').textContent=job.error;
  if(job.data){
    const comma=job.data.indexOf(','),header=job.data.slice(5,comma),type=header.split(';')[0];
    const data=header.includes(';base64')?Uint8Array.from(atob(job.data.slice(comma+1)),c=>c.charCodeAt(0)):decodeURIComponent(job.data.slice(comma+1));
    selected=new File([data],'image.'+(type.split('/')[1]||'png'),{type});
    await message('clear');$('selected').hidden=false;$('selected').textContent='Selected image from the page';
    if(providers[job.provider])await submit();
  }
}
$('file').onchange=()=>{selected=null;$('selected').hidden=true;if($('file').files.length)$('url').value='';};
$('url').oninput=()=>{selected=null;$('selected').hidden=true;$('file').value='';};
$('search').onsubmit=e=>{e.preventDefault();$('search').querySelector('button').disabled=true;submit().catch(error);};
start().catch(error);
