from pathlib import Path
import os
import tempfile
import unittest
from playwright.sync_api import sync_playwright

EXT=Path(__file__).resolve().parents[1]/'extension'
BRAVE=Path(os.environ['ProgramFiles'])/'BraveSoftware/Brave-Browser/Application/brave.exe'
HLS='''#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="en",NAME="English",URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,AUDIO="en"
small.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2200000,RESOLUTION=1280x720,AUDIO="en"
medium.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="en"
large.m3u8
'''
DASH='<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period><AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="test"/><Representation id="lo" height="480" bandwidth="900000"/><Representation id="hi" height="1080" bandwidth="5000000"/></AdaptationSet><AdaptationSet mimeType="audio/mp4"><Representation id="sound"/></AdaptationSet></Period></MPD>'
class QualityTest(unittest.TestCase):
    def test_player_and_popup(self):
        with tempfile.TemporaryDirectory() as tmp,sync_playwright() as pw:
            ctx=pw.chromium.launch_persistent_context(tmp,executable_path=str(BRAVE),headless=True,ignore_default_args=['--disable-extensions'],args=['--load-extension='+str(EXT),'--disable-extensions-except='+str(EXT)])
            try:
                def fixture(r):
                    path=r.request.url
                    if path.endswith('m3u8'):r.fulfill(content_type='application/vnd.apple.mpegurl',body=HLS)
                    elif path.endswith('mpd'):r.fulfill(content_type='application/dash+xml',body=DASH)
                    else:r.fulfill(content_type='text/html',body='<video muted autoplay></video>')
                ctx.route('https://**/*',fixture)
                page=ctx.pages[0];page.goto('https://www.paramountplus.com/watch/fixture/')
                worker=ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
                def hls():return page.evaluate("fetch('/master.m3u8').then(r=>r.text())")
                def dash(typ):return page.evaluate("""type=>new Promise(resolve=>{const x=new XMLHttpRequest();x.open('GET','/live.mpd');x.responseType=type;x.onload=()=>resolve(type==='document'?new XMLSerializer().serializeToString(x.responseXML):type==='arraybuffer'?new TextDecoder().decode(x.response):x.responseText);x.send()})""",typ)
                self.assertEqual(hls(),HLS)
                page.evaluate("const c=document.createElement('canvas');c.width=320;c.height=180;const v=document.querySelector('video');v.srcObject=c.captureStream(10);c.getContext('2d').fillRect(0,0,320,180);v.play()")
                page.wait_for_function("document.querySelector('video').videoHeight===180")
                popup=ctx.new_page();page.bring_to_front();popup.goto(worker.url.rsplit('/',1)[0]+'/popup.html')
                popup.locator('#actual').get_by_text('320 × 180').wait_for()
                self.assertEqual(worker.evaluate("async()=>chrome.action.getBadgeText({tabId:(await chrome.tabs.query({active:true,currentWindow:true}))[0].id})"),'180')
                popup.locator('#available').get_by_text('1080p · 720p · 360p').wait_for()
                popup.locator('#mode').select_option('720')
                popup.get_by_text('Saved.',exact=False).wait_for()
                page.reload()
                narrowed=hls();self.assertIn('medium.m3u8',narrowed);self.assertNotIn('large.m3u8',narrowed);self.assertNotIn('small.m3u8',narrowed);self.assertIn('audio.m3u8',narrowed)
                limited=dash('text');self.assertIn('id="lo"',limited);self.assertNotIn('id="hi"',limited);self.assertIn('ContentProtection',limited)
                popup.locator('#mode').select_option('max')
                page.wait_for_function("async()=>!(await fetch('/master.m3u8').then(r=>r.text())).includes('medium.m3u8')")
                highest=dash('document');self.assertIn('id="hi"',highest);self.assertNotIn('id="lo"',highest);self.assertIn('id="sound"',highest)
                self.assertEqual(dash('arraybuffer'),highest)
                popup.locator('#mode').select_option('auto')
                page.reload();self.assertEqual(hls(),HLS);self.assertEqual(dash('text'),DASH)
            finally:ctx.close()
if __name__=='__main__':unittest.main()
