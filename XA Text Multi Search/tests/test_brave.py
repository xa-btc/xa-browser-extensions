import functools
import http.server
import os
import tempfile
import threading
import unittest
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / 'extension'
BRAVE = Path(os.environ['ProgramFiles']) / 'BraveSoftware/Brave-Browser/Application/brave.exe'


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


class SearchInBrave(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temp=tempfile.TemporaryDirectory(prefix='xa-text-search-')
        cls.addClassCleanup(temp.cleanup)
        root=Path(temp.name)
        (root/'index.html').write_text('<meta charset=utf-8><p>Blue <em>moon</em> and BLUE moon. Café.</p><p>other</p><input type=text value="Café inside"><input type=password value="Café secret"><iframe src="child.html"></iframe>',encoding='utf-8')
        (root/'child.html').write_text('<p>Blue moon.</p>',encoding='utf-8')
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=root))
        threading.Thread(target=server.serve_forever,daemon=True).start()
        cls.addClassCleanup(server.server_close)
        cls.addClassCleanup(server.shutdown)
        cls.url=f'http://127.0.0.1:{server.server_port}/index.html'
        pw=sync_playwright().start()
        cls.addClassCleanup(pw.stop)
        cls.ctx=pw.chromium.launch_persistent_context(str(root/'profile'),executable_path=str(BRAVE),headless=True,
            ignore_default_args=['--disable-extensions'],args=['--load-extension='+str(EXT),'--disable-extensions-except='+str(EXT),'--disable-background-networking','--no-first-run'])
        cls.addClassCleanup(cls.ctx.close)
        cls.worker=cls.ctx.service_workers[0] if cls.ctx.service_workers else cls.ctx.wait_for_event('serviceworker')
        cls.base=cls.worker.url.rsplit('/',1)[0]

    def setUp(self):
        self.worker.evaluate('chrome.storage.local.clear()')
        self.page=self.ctx.new_page()
        self.addCleanup(self.page.close)
        self.page.goto(self.url)
        self.page.wait_for_load_state()
        self.tab=self.worker.evaluate('async url=>(await chrome.tabs.query({})).find(t=>t.url===url)?.id',self.url)
        # tabs.query omits URL without tabs permission. The actual content connection supplies the tab ID.
        self.tab=self.tab or self.worker.evaluate('async () => { for(let i=0;i<100;i++){const entry=[...frames.entries()].find(([,f])=>f.size===2);if(entry)return entry[0];await new Promise(r=>setTimeout(r,30));}throw Error("missing frames"); }')
        self.worker.evaluate('async id=>activate(await chrome.tabs.get(id))',self.tab)
        self.cdp=self.ctx.new_cdp_session(self.page)
        self.cdp.send('DOM.enable')
        for _ in range(70):
            doc=self.cdp.send('DOM.getDocument',{'depth':-1,'pierce':True})['root']
            def find_panel(node):
                for shadow in node.get('shadowRoots',[]):
                    if any(c.get('attributes',[])[:2]==['class','box'] or c.get('attributes',[])[:2]==['class','box light'] for c in shadow.get('children',[])):
                        return shadow['nodeId']
                for c in node.get('children',[]):
                    found=find_panel(c)
                    if found:return found
            result=find_panel(doc)
            if result:break
            self.page.wait_for_timeout(40)
        self.assertTrue(result,'XT panel opened')
        self.shadow=self.cdp.send('DOM.resolveNode',{'nodeId':result})['object']['objectId']

    def ui(self, body):
        reply=self.cdp.send('Runtime.callFunctionOn',{'objectId':self.shadow,'functionDeclaration':'function(){'+body+'}','returnByValue':True,'awaitPromise':True})
        self.assertNotIn('exceptionDetails',reply,reply)
        return reply['result'].get('value')

    def words(self,value):
        import json
        self.ui("const e=this.querySelector('textarea');e.value="+json.dumps(value)+";e.dispatchEvent(new Event('input'));")

    def counts(self,expected):
        for _ in range(90):
            value=self.ui("return [...this.querySelectorAll('.count')].map(e=>Number(e.textContent))")
            if value==expected:return
            self.page.wait_for_timeout(35)
        self.assertEqual(value,expected)

    def click(self,label):
        import json
        self.ui("return [...this.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||b.textContent)==="+json.dumps(label)+").click()")

    def test_compact_panel_controls_and_long_groups(self):
        group='blue|'+'|'.join('alternative'+str(i) for i in range(45))
        self.words(group+'\nmoo')
        self.counts([3,3])
        self.click('Options for moo')
        self.ui("const m=this.querySelector('.properties select');m.value='exact';m.dispatchEvent(new Event('change'))")
        self.counts([3,0])
        self.click('Partial')
        self.counts([3,3])
        self.click('Hide moo')
        self.counts([3,0])
        self.click('Show moo')
        self.counts([3,3])
        self.ui("this.querySelector('details').open=false")
        for width in (1000,360):
            self.page.set_viewport_size({'width':width,'height':700})
            layout=self.ui("const b=this.querySelector('.box'),track=this.querySelector('.term-track');track.scrollLeft=100;return [b.scrollWidth<=b.clientWidth,b.getBoundingClientRect().right<=innerWidth,track.scrollLeft>0,!this.querySelector('textarea').checkVisibility({contentVisibilityAuto:true})]")
            self.assertEqual(layout,[True]*4)
        self.ui("this.querySelector('summary').click()")
        self.assertTrue(self.ui("return this.querySelector('textarea').getBoundingClientRect().height>0"))

    def test_inline_alternatives_and_marker_edges(self):
        self.ui("this.querySelector('.add-row input').focus()")
        self.page.keyboard.type('one|two|three')
        self.page.keyboard.press('Enter')
        self.counts([0])
        self.click('one|two|three')
        self.page.keyboard.type('|blue',delay=50)
        self.counts([3])
        self.page.keyboard.press('Enter')
        self.assertEqual(self.ui("return [...this.querySelectorAll('.token')].map(t=>t.textContent)"),['one','two','three','blue'])
        rail=self.page.locator('canvas[aria-label="Search result positions"]')
        for edge in ('right','left'):
            if edge=='left':self.click('Markers: right')
            self.page.wait_for_function("edge=>document.querySelector('canvas[aria-label]')?.style[edge]==='0px'",arg=edge)
            # The broad base sits against the edge and the narrow tip points into the page.
            ink=rail.evaluate("""c=>{const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
                return [3,10].map(x=>{let count=0;for(let y=0;y<c.height;y++)if(pixels[(y*c.width+x)*4+3])count++;return count})}""")
            self.assertGreater(ink[edge=='right'],ink[edge=='left'])
        rail.click(position={'x':6,'y':30})
        self.page.wait_for_function("CSS.highlights.has('xt-current')")

    def test_bright_highlights_are_optional_and_persist(self):
        self.worker.evaluate("chrome.storage.local.set({settings:{style:'glow'}})")
        self.words('Blue')
        self.counts([3])
        style="() => getComputedStyle(document.querySelector('p'),'::highlight(xt-term-0)')"
        self.page.wait_for_function("("+style+")().textShadow!=='none'")
        baseline=self.page.evaluate("("+style+")().backgroundColor")
        self.assertEqual(baseline,'rgba(0, 0, 0, 0)')
        clip=self.page.evaluate("() => {const r=document.createRange();r.setStart(document.querySelector('p').firstChild,0);r.setEnd(r.startContainer,4);const {x,y,width,height}=r.getBoundingClientRect();return {x,y,width,height}}")
        before=self.page.screenshot(clip=clip)
        self.click('Bright highlights')
        self.page.wait_for_function("document.querySelector('p > span')?.textContent==='Blue'")
        match=self.page.locator('p > span').first
        self.assertEqual(match.evaluate("e=>getComputedStyle(e).borderRadius"),'3.2px')
        self.assertIn('8px 1.6px',match.evaluate("e=>getComputedStyle(e).boxShadow"))
        self.assertNotEqual(before,self.page.screenshot(clip=clip))
        options=self.ctx.new_page()
        self.addCleanup(options.close)
        options.goto(self.base+'/settings.html')
        self.assertTrue(options.locator('[name=bright]').is_checked())
        options.locator('[name=style]').select_option('none')
        options.get_by_role('button',name='Save settings').click()
        self.page.wait_for_function("("+style+")().textShadow==='none' && ("+style+")().backgroundColor==='rgba(0, 0, 0, 0)'")
        self.page.wait_for_function("!document.querySelector('p > span')")
        self.counts([3])
        options.locator('[name=style]').select_option('glow')
        options.get_by_role('button',name='Save settings').click()
        self.page.wait_for_function("document.querySelector('p > span')")
        self.click('Bright highlights')
        self.page.wait_for_function("("+style+")().backgroundColor==='rgba(0, 0, 0, 0)'")
        self.page.wait_for_function("!document.querySelector('p > span')")
        self.assertEqual(before,self.page.screenshot(clip=clip))

    def test_bright_highlights_preserve_text_positions(self):
        self.page.evaluate("""() => {
            const fixture=document.createElement('section');
            fixture.innerHTML='<style>#spacing span {display:block!important;margin:0 80px!important}</style>';
            fixture.id='spacing';
            for(const display of ['flex','grid','block']){
                const line=document.createElement('div');
                line.style.cssText='width:700px;padding:12px;background:#304146;display:'+display+';justify-content:space-between;grid-auto-flow:column';
                line.append('Buy FFXIV gil here on EpicNPC. Sellers can list their gil for sale!');
                fixture.append(line);
            }
            document.body.append(fixture);
        }""")
        positions="""() => Array.from(document.querySelectorAll('#spacing div'),line=>{
            const walker=document.createTreeWalker(line,NodeFilter.SHOW_TEXT);
            const points=[];
            while(walker.nextNode()){
                const node=walker.currentNode,range=document.createRange();
                for(let i=0;i<node.length;i++){
                    range.setStart(node,i);range.setEnd(node,i+1);
                    const rect=range.getBoundingClientRect();points.push([rect.x,rect.y]);
                }
            }
            return points;
        })"""
        baseline=self.page.evaluate(positions)
        self.words('EpicNPC')
        self.counts([3])
        self.click('Bright highlights')
        self.page.wait_for_function("document.querySelector('#spacing div:last-child span')")
        after=self.page.evaluate(positions)
        self.assertEqual(after[:2],baseline[:2])
        # Chromium rounds split inline runs to fractional CSS pixels.
        for actual,expected in zip(after[2],baseline[2],strict=True):
            self.assertAlmostEqual(actual[0],expected[0],delta=0.05)
            self.assertEqual(actual[1],expected[1])
        self.assertEqual(self.page.evaluate("Array.from(CSS.highlights.get('xt-bright-0'),r=>r.toString())"),['EpicNPC']*2)
        self.worker.evaluate("chrome.storage.local.get('settings').then(({settings})=>chrome.storage.local.set({settings:{...settings,style:'glow'}}))")
        self.page.wait_for_function("document.querySelector('#spacing div:first-of-type span span')?.style.boxShadow")
        # Compare the full painted word, including pixels outside its box.
        clips=self.page.locator('#spacing div').evaluate_all("""lines=>lines.map(line=>{
            const word=Array.from(line.querySelectorAll('span')).find(s=>s.textContent==='EpicNPC');
            const r=word.getBoundingClientRect();
            return {x:Math.floor(r.x)-8,y:Math.floor(r.y)-8,width:Math.ceil(r.width)+16,height:Math.ceil(r.height)+16};
        })""")
        pixels=[self.page.screenshot(clip=clip) for clip in clips]
        self.assertEqual(pixels[0]==pixels[2],True,'flex glow should match inline glow')
        self.assertEqual(pixels[1]==pixels[2],True,'grid glow should match inline glow')
        for line,original in zip(self.page.evaluate(positions),baseline,strict=True):
            for actual,expected in zip(line,original,strict=True):
                self.assertAlmostEqual(actual[0],expected[0],delta=0.05)
                self.assertEqual(actual[1],expected[1])
        self.click('Bright highlights')
        self.page.wait_for_function("!document.querySelector('#spacing span')")
        self.assertEqual(self.page.evaluate(positions),baseline)

    def test_cross_frame_navigation_mutation_and_history(self):
        self.words('Blue moon\ncafe')
        self.counts([3,1])
        self.click('Next')
        self.page.wait_for_function("CSS.highlights.get('xt-current')?.size===1")
        self.assertEqual(self.page.evaluate("Array.from(CSS.highlights.get('xt-current'))[0].toString()"),'Blue moon')
        self.page.evaluate("const p=document.createElement('p');p.textContent='Café';document.body.append(p)")
        self.counts([3,2])
        self.click('Case')
        self.counts([2,0])
        self.click('Clear unfound')
        self.counts([2])
        self.click('Undo')
        self.counts([2,0])

    def test_settings_fields_and_masks(self):
        self.words('cafe')
        self.counts([1])
        options=self.ctx.new_page()
        self.addCleanup(options.close)
        options.goto(self.base+'/settings.html')
        options.locator('[name=fields]').check()
        options.get_by_role('button',name='Save settings').click()
        options.get_by_text('Settings saved.').wait_for()
        self.counts([2])
        # Only the top document matches this pattern. Its child must also stop searching.
        options.locator('[name=patterns]').fill(self.url)
        options.get_by_role('button',name='Save settings').click()
        self.counts([0])

    def test_badge_panel_visibility_and_dynamic_fields(self):
        self.words('blue moon')
        self.counts([3])
        self.assertEqual(self.worker.evaluate('id=>chrome.action.getBadgeText({tabId:id})',self.tab),'3')
        self.click('Highlights: always')
        self.click('Close')
        self.page.wait_for_function("!CSS.highlights.has('xt-term-0')")
        self.assertEqual(self.ui("return getComputedStyle(this.host).display"),"none")
        self.worker.evaluate('async id=>activate(await chrome.tabs.get(id))',self.tab)
        self.counts([3])
        self.assertEqual(self.ui("return getComputedStyle(this.host).right"),"12px")
        self.worker.evaluate("chrome.storage.local.get('settings').then(({settings})=>chrome.storage.local.set({settings:{...settings,fields:true}}))")
        self.page.locator('input[type=text]').fill('Blue moon')
        self.counts([4])

    def test_local_palette_and_extension_network_policy(self):
        options=self.ctx.new_page()
        self.addCleanup(options.close)
        options.goto(self.base+'/settings.html')
        options.locator('#palette input[type=color]').first.wait_for()
        options.get_by_role('button',name='Add pair').click()
        self.assertEqual(options.locator('#palette .colors').count(),7)
        with options.expect_download() as pending:
            options.get_by_role('button',name='Export palette').click()
        import json
        contents=json.loads(Path(pending.value.path()).read_text())
        self.assertEqual(len(contents['light']),7)
        contents['light'][0]={'back':'#123456','front':'#fedcba'}
        options.locator('#paletteFile').set_input_files({'name':'colors.json','mimeType':'application/json','buffer':json.dumps(contents).encode()})
        options.get_by_text('Palette imported.',exact=False).wait_for()
        options.get_by_role('button',name='Save settings').click()
        options.get_by_text('Settings saved.').wait_for()
        stored=options.evaluate("chrome.storage.local.get('settings').then(r=>r.settings)")
        self.assertEqual([stored['light'][0],stored['lightInk'][0]],['#123456','#fedcba'])
        with options.expect_event('console',predicate=lambda event:"connect-src 'none'" in event.text):
            self.assertTrue(options.evaluate("async url=>{try{await fetch(url);return false}catch{return true}}",self.url))

    def test_export_import_and_term_properties(self):
        self.words('blue\ncafe')
        self.counts([3,1])
        self.click('Options for cafe')
        self.ui("const n=this.querySelector('input[placeholder=Annotation]');n.value='note';n.dispatchEvent(new Event('change'))")
        self.page.wait_for_timeout(180)
        with self.page.expect_download() as pending:
            self.click('Export JSON')
        import json
        data=json.loads(Path(pending.value.path()).read_text())
        self.assertEqual(data[1]['note'],'note')
        self.click('Clear all')
        self.counts([])
        self.ui("const file=new File(['violet\\nBlue moon'],'list.txt');const transfer=new DataTransfer();transfer.items.add(file);const input=this.querySelector('input[type=file]');input.files=transfer.files;input.dispatchEvent(new Event('change'));")
        self.counts([0,3])

