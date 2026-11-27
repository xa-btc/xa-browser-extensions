const {test}=require('node:test');
const assert=require('node:assert/strict');
require('../extension/model.js');
const {defaults,terms,find}=XT;
const matches=(source,term,settings={},options={})=>find(source,terms([{text:term,...options}])[0],{...defaults,...settings}).map(([a,b])=>source.slice(a,b));
test('case, combining accents, and phrase offsets',()=>{
  assert.deepEqual(matches('École ECOLE e\u0301cole','école'),['École','ECOLE','e\u0301cole']);
  assert.deepEqual(matches('École école ecole','école',{caseSensitive:true,accents:true}),['école']);
  assert.deepEqual(matches('read red blue','red blue'),['red blue']);
});
test('location distinguishes initial, partial, final and exact',()=>{
  const source='cat catnap bobcat cater';
  for(const [position,expected] of Object.entries({exact:1,initial:3,final:2,partial:4}))
    assert.equal(matches(source,'cat',{position}).length,expected);
  assert.deepEqual(matches('a b a','a'),[]);
  assert.deepEqual(matches('a b a','a',{single:true}),['a','a']);
});
test('wildcards use letters and digits, bounded lengths, and literal mode',()=>{
  const settings={wild:true,position:'exact'};
  assert.deepEqual(matches('cat cats cat5 cat-dog','cat*',settings),['cat','cats','cat5','cat']);
  assert.deepEqual(matches('cot cut ct c!t','c?t',settings),['cot','cut']);
  assert.deepEqual(matches('to t1234o t12345o txxo','t!{4}o',settings),['to','t1234o','txxo']);
  assert.deepEqual(matches('abc 😀 def 123 1234','?{3}',settings),['abc','def','123']);
  assert.deepEqual(matches('color colour colouur','colo!r',settings),['color','colour']);
  assert.deepEqual(matches('x?y xay','x?y'),['x?y']);
});
test('overlapping alternatives and list editing preserve row metadata',()=>{
  assert.deepEqual(matches('cat cater','cat|cater'),['cat','cater']);
  const rows=terms([{text:'one',note:'n'},{text:'two',color:'#334455'}]);
  assert.equal(XT.reconcile('two\none',rows)[0].color,'#334455');
  assert.equal(XT.reconcile('new\ntwo',rows)[0].note,'n');
  assert.equal(terms([{text:'old',loc:0,maj:true,diac:false,on:false,colIndex:4,comment:'memo'}])[0].position,'exact');
});
test('site globs and palette validation',()=>{
  assert.equal(XT.allowed('https://a.test/docs/x',{...defaults,patterns:'https://*.test/docs/?'}),false);
  assert.equal(XT.allowed('https://ok.test/',{...defaults,patterns:'ok.test',policy:'allow'}),true);
  assert.throws(()=>XT.palette({light:['bad']}));
  assert.throws(()=>XT.palette({light:['#123456'],dark:['#123456','#123456']}));
  assert.deepEqual(XT.palette({light:[{back:'#123456',front:'#ffffff'}]}).lightInk,['#ffffff']);
});

