import base64
import os
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from playwright.sync_api import sync_playwright

EXT=Path(__file__).resolve().parents[1]/'extension'
BRAVE=Path(os.environ['ProgramFiles'])/'BraveSoftware/Brave-Browser/Application/brave.exe'
PNG=(EXT/'icons/16.png').read_bytes()

class ImageSearchTest(unittest.TestCase):
    def test_selected_image_and_provider_handoffs(self):
        with tempfile.TemporaryDirectory() as tmp,sync_playwright() as pw:
            ctx=pw.chromium.launch_persistent_context(tmp,executable_path=str(BRAVE),headless=True,
                ignore_default_args=['--disable-extensions'],args=['--load-extension='+str(EXT),'--disable-extensions-except='+str(EXT)])
            try:
                worker=ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
                ext=worker.url.rsplit('/',1)[0]
                ctx.set_default_timeout(7000)
                requests=[]
                def fixture(route):
                    req=route.request
                    requests.append((req.method,req.url,req.post_data_buffer))
                    u=urlsplit(req.url)
                    if u.hostname=='lens.google.com':
                        return route.fulfill(content_type='text/html',body="<script>location.replace('https://www.google.com/search?vsrid=fixture&hl=en')</script>")
                    if u.hostname=='www.google.com':
                        html='<a href="/search?vsrid=fixture&exact=selected">Exact matches</a>'
                    elif u.hostname=='graph.baidu.com':
                        html='<input class="graph-d20-search-wrapper-input"><button class="graph-d20-search-btn" onclick="document.title=document.querySelector(\'input\').value">Submit</button><input type="file" onchange="document.title=this.files[0].name">'
                    elif u.hostname=='yandex.com':
                        html='<input type="file" onchange="document.title=this.files[0].name">'
                    else:html='<p>Provider</p>'
                    route.fulfill(content_type='text/html',body=html)
                ctx.route('https://**/*',fixture)
                source=ctx.pages[0]
                source.goto('https://example.org/gallery')
                tab=worker.evaluate("chrome.tabs.query({active:true,currentWindow:true}).then(t=>({id:t[0].id,index:t[0].index}))")
                url='https://img.example.org/photo.png?a=1&b=2'
                def chosen(provider,src,link=None):
                    with ctx.expect_page() as created:
                        worker.evaluate('([provider,src,link,tab])=>chosen({menuItemId:provider,srcUrl:src,linkUrl:link},tab)',[provider,src,link,tab])
                    return created.value
                for provider,host,key in [('bing','www.bing.com','imgurl'),('tineye','tineye.com','url'),('yandex','yandex.com','url')]:
                    out=chosen(provider,'https://example.org/thumb.jpg',url)
                    out.wait_for_url('https://'+host+'/**')
                    self.assertEqual(parse_qs(urlsplit(out.url).query)[key],[url])
                    out.close()
                out=chosen('google',url)
                out.wait_for_url('**/search?vsrid=fixture&exact=selected')
                self.assertEqual(parse_qs(urlsplit(next(u for m,u,d in requests if 'lens.google.com/uploadbyurl' in u)).query)['url'],[url])
                out.close()
                # Only the search tab that XI opened should switch to Exact matches.
                source.goto('https://www.google.com/search?vsrid=other')
                source.wait_for_timeout(150)
                self.assertNotIn('exact=selected',source.url)
                out=chosen('baidu',url)
                out.wait_for_function("s=>document.title===s",arg=url)
                out.close()
                data='data:image/png;base64,'+base64.b64encode(PNG).decode()
                out=chosen('tineye',data)
                out.wait_for_url('https://tineye.com/search')
                self.assertTrue(any(m=='POST' and u.startswith('https://tineye.com/') and PNG in body for m,u,body in requests))
                out.close()
                for provider in ('google','bing','yandex','baidu'):
                    out=ctx.new_page();out.goto(ext+'/search.html')
                    out.locator('#file').set_input_files({'name':'fixture.png','mimeType':'image/png','buffer':PNG})
                    out.locator('select').select_option(provider)
                    out.get_by_role('button',name='Search image').click()
                    if provider=='google':
                        out.wait_for_url('**/search?vsrid=fixture&exact=selected')
                        self.assertTrue(any(m=='POST' and 'lens.google.com/v3/upload' in u and PNG in body for m,u,body in requests))
                    elif provider=='bing':
                        out.wait_for_url('https://www.bing.com/**')
                        self.assertTrue(any(m=='POST' and 'bing.com' in u and base64.b64encode(PNG) in body for m,u,body in requests))
                    else:
                        out.wait_for_url('https://**/*')
                        out.wait_for_function("document.title==='fixture.png'")
                    out.close()
            finally:ctx.close()

if __name__=='__main__':unittest.main()
