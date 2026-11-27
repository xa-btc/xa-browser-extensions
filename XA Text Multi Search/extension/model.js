'use strict';
globalThis.XT = (() => {
  const light = ['#ffe391','#a9eaca','#a9d5ff','#ffbad4','#cdbafa','#ffba91'];
  const dark = ['#e6bd59','#77d4a1','#85bcf5','#f49cba','#b9a0ef','#f5a272'];
  const defaults = {
    caseSensitive:false, accents:false, wild:false, single:false, position:'partial', separator:'|',
    visibility:'always', style:'solid', bright:false, marks:true, markSide:'right', sound:'off', badge:'nonzero', fields:false, editable:true,
    theme:'system', corner:'top-right', opacity:100, pinned:true, opening:'preserve', context:'advanced',
    policy:'block', patterns:'', light, dark, hidden:[]
  };
  const locations = ['exact','initial','partial','final'];
  const color = value => /^#[0-9a-f]{6}$/i.test(value);
  function terms(input) {
    if (!Array.isArray(input)) throw Error('Expected a JSON array of search expressions.');
    return input.map((item,index) => {
      const r = typeof item === 'string' ? {text:item} : item;
      if (typeof r?.text !== 'string') throw Error('Each expression needs a text field.');
      return {
        text:r.text.trim(), enabled:(r.enabled ?? r.on) !== false, note:String(r.note ?? r.comment ?? ''),
        slot:Math.max(0,Math.floor(Number(r.slot ?? r.colIndex ?? index) || 0)), color:color(r.color) ? r.color : '',
        position:locations.includes(r.position) ? r.position : (locations[r.loc] || ''),
        caseSensitive:r.caseSensitive ?? r.maj ?? null, accents:r.accents ?? r.diac ?? null
      };
    }).filter(row => row.text);
  }
  function reconcile(lines, previous) {
    const available = [...previous];
    const values = lines.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    const retained = values.map(text => {
      const index=available.findIndex(r=>r.text===text);
      return index<0 ? null : available.splice(index,1)[0];
    });
    return values.map((text,i)=>retained[i] || {...(available.shift() || terms([{text,slot:i}])[0]),text});
  }
  const escape = text => text.replace(/[.*+?^$()|[\]\\]/g,'\\$&');
  function allowed(url, settings) {
    const matched = settings.patterns.split(/\r?\n/).map(p=>p.trim()).filter(Boolean).some(pattern=>{
      const hostOnly = !pattern.includes('/') && !pattern.includes(':');
      let value=url;
      if(hostOnly) { try { value=new URL(url).hostname; } catch { return false; } }
      const parts=pattern.split(/([*?])/).map(s=>s==='*'?'.*':s==='?'?'.':escape(s));
      return new RegExp('^'+parts.join('')+'$','i').test(value);
    });
    return settings.policy==='allow' ? matched : !matched;
  }
  function folded(text, sensitive, accents) {
    const chars=[], offsets=[0];
    let offset=0;
    for (const original of text) {
      let value=sensitive ? original : original.toLowerCase();
      if (!accents) value=value.normalize('NFD').replace(/\p{M}/gu,'');
      offset+=original.length;
      for (const ch of value) { chars.push(ch); offsets.push(offset); }
      if (!value) offsets[offsets.length-1]=offset;
    }
    return {chars,offsets};
  }
  const word = c => !!c && /[\p{L}\p{M}\p{N}_]/u.test(c);
  const wildcardChar = c => !!c && /[\p{L}\p{N}]/u.test(c);
  // Each column stores the longest valid end for a match starting at that offset.
  // Sliding maxima keep variable-width wildcard matching linear per token.
  function wildcardEnds(chars, tokens, rightBoundary) {
    const n=chars.length;
    let ends=Int32Array.from({length:n+1},(_,i)=>rightBoundary && word(chars[i]) ? -1 : i);
    for (const token of tokens.toReversed()) {
      const next=new Int32Array(n+1).fill(-1);
      if (typeof token==='string') {
        for(let i=0;i<n;i++) if(chars[i]===token) next[i]=ends[i+1];
      } else {
        const queue=new Int32Array(n+1);
        let head=0,tail=0,runEnd=n;
        for(let i=n;i>=0;i--) {
          if(i<n && !wildcardChar(chars[i])) {head=tail=0;runEnd=i;}
          const lower=i+token.min, upper=Math.min(runEnd,i+token.max);
          while(head<tail && queue[head]>upper) head++;
          if(lower<=upper) {
            while(head<tail && ends[queue[tail-1]]<=ends[lower]) tail--;
            queue[tail++]=lower;
          }
          if(head<tail) next[i]=ends[queue[head]];
        }
      }
      ends=next;
    }
    return ends;
  }
  function find(text, row, settings, cache=new Map()) {
    const sensitive=row.caseSensitive ?? settings.caseSensitive, accents=row.accents ?? settings.accents;
    const key=Number(sensitive)*2+Number(accents);
    if (!cache.has(key)) cache.set(key,folded(text,sensitive,accents));
    const {chars,offsets}=cache.get(key);
    const location=row.position || settings.position;
    const left=location==='exact'||location==='initial', right=location==='exact'||location==='final';
    const matches=[];
    const alternatives=settings.separator ? row.text.split(settings.separator) : [row.text];
    for(const raw of alternatives) {
      const expr=raw.trim();
      if(!expr || (!settings.single && [...expr].length<2)) continue;
      const pattern=folded(expr,sensitive,accents).chars.join('');
      if(!pattern) continue;
      let ends;
      if(settings.wild && /[*!?]/.test(pattern)) {
        const tokens=[];
        for(const match of pattern.matchAll(/([?!])(?:\{(\d+)\})?|\*|[\s\S]/gu)) {
          if(match[0]==='*') tokens.push({min:0,max:Infinity});
          else if(match[1]) {
            const count=Number(match[2]??1);
            tokens.push({min:match[1]==='?'?count:0,max:count});
          } else tokens.push(match[0]);
        }
        ends=wildcardEnds(chars,tokens,right);
      }
      const literal=[...pattern];
      for(let i=0;i<chars.length;i++) {
        if(left && word(chars[i-1])) continue;
        const end=ends ? ends[i] : i+literal.length;
        if(end<=i || end>chars.length || (!ends && (chars[i]!==literal[0] || !literal.every((ch,j)=>ch===chars[i+j]))) || (right && word(chars[end]))) continue;
        matches.push([offsets[i],offsets[end]]);
        i=end-1;
      }
    }
    matches.sort((a,b)=>a[0]-b[0] || b[1]-a[1]);
    let previousEnd=-1;
    return matches.filter(([start,end])=>{if(start<previousEnd || end<=start)return false; previousEnd=end;return true;});
  }
  function palette(value) {
    function read(list) {
      if (!Array.isArray(list) || !list.length || list.length>20) throw Error('Choose 1 to 20 palette colors.');
      return list.map(c=>{const v=typeof c==='string'?c:c?.back;if(!color(v))throw Error('Invalid palette color.');return v;});
    }
    const light=read(value.light ?? value.dark),dark=read(value.dark ?? value.light);
    if(light.length!==dark.length) throw Error('Light and dark palettes need the same number of colors.');
    const ink = theme => {
      const entries=value[theme] ?? value[theme==='light'?'dark':'light'];
      return entries.map((entry,i)=>{
        const input=value[theme+'Ink']?.[i] ?? entry?.front;
        if(color(input)) return input;
        if(input && typeof document!=='undefined' && CSS.supports('color',input)) {
          const ctx=document.createElement('canvas').getContext('2d');ctx.fillStyle=input;
          if(color(ctx.fillStyle)) return ctx.fillStyle;
        }
        return '#17202d';
      });
    };
    return {light,dark,lightInk:ink('light'),darkInk:ink('dark')};
  }
  return {defaults,terms,reconcile,find,allowed,palette,locations};
})();

