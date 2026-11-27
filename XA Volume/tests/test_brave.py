"""Exercise the unpacked extension with an actual Brave toolbar invocation."""
import functools
import http.server
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest


from playwright.sync_api import sync_playwright

EXT=Path(__file__).resolve().parents[1]/'extension'
BRAVE=Path(os.environ['ProgramFiles'])/'BraveSoftware/Brave-Browser/Application/brave.exe'

class AudioTest(unittest.TestCase):
    def test_tab_audio(self):
        with tempfile.TemporaryDirectory() as temp, sync_playwright() as pw:
            root=Path(temp)
            (root/'index.html').write_text('<title>XV tone</title><button onclick="const c=new AudioContext(),o=c.createOscillator(),g=c.createGain();g.gain.value=.02;o.connect(g);g.connect(c.destination);o.start()">Play tone</button>')
            server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(http.server.SimpleHTTPRequestHandler,directory=temp))
            threading.Thread(target=server.serve_forever,daemon=True).start()
            try:
                profile=root/'profile'
                ctx=pw.chromium.launch_persistent_context(str(profile),executable_path=str(BRAVE),headless=True,ignore_default_args=['--disable-extensions'],args=['--load-extension='+str(EXT),'--disable-extensions-except='+str(EXT),'--enable-unsafe-extension-debugging','--autoplay-policy=no-user-gesture-required'])
                try:
                    page=ctx.pages[0];page.goto(f'http://127.0.0.1:{server.server_port}/index.html');page.get_by_role('button').click()
                    worker=ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
                    ext_id=worker.url.split('/')[2]
                    browser_cdp=ctx.browser.new_browser_cdp_session()
                    target=browser_cdp.send('Target.getTargets',{'filter':[{'type':'tab'}]})['targetInfos'][0]['targetId']
                    browser_cdp.send('Extensions.triggerAction',{'id':ext_id,'targetId':target})
                    replies={}
                    def receive(event):
                        message=json.loads(event['message'])
                        if 'id' in message:replies[event['sessionId']]=message
                    browser_cdp.on('Target.receivedMessageFromTarget',receive)
                    def evaluate(file,expression):
                        targets=browser_cdp.send('Target.getTargets')['targetInfos']
                        endpoint=next(t['targetId'] for t in targets if t['url']==f'chrome-extension://{ext_id}/{file}')
                        sid=browser_cdp.send('Target.attachToTarget',{'targetId':endpoint})['sessionId']
                        try:
                            cmd={'id':1,'method':'Runtime.evaluate','params':{'expression':expression,'returnByValue':True,'awaitPromise':True}}
                            browser_cdp.send('Target.sendMessageToTarget',{'sessionId':sid,'message':json.dumps(cmd)})
                            for _ in range(200):
                                if sid in replies:break
                                page.wait_for_timeout(10)
                            reply=replies.pop(sid)['result']
                            self.assertNotIn('exceptionDetails',reply)
                            return reply['result'].get('value')
                        finally:
                            browser_cdp.send('Target.detachFromTarget',{'sessionId':sid})
                    for _ in range(50):
                        try:
                            if evaluate('popup.html',"document.querySelector('#site')?.textContent==='XV tone'"):break
                        except StopIteration:pass
                        page.wait_for_timeout(100)
                    self.assertEqual(evaluate('popup.html',"getComputedStyle(document.documentElement).colorScheme"),'dark')
                    def volume(amount):
                        evaluate('popup.html',f"document.querySelector('#volume').value={amount};document.querySelector('#volume').dispatchEvent(new Event('change'))")
                    def channel(expected):
                        for _ in range(60):
                            try:
                                actual=evaluate('audio.html',"[...channels.values()].map(c=>[c.gain.gain.value,c.context.state,c.stream.getAudioTracks()[0].readyState])")
                                if actual and abs(actual[0][0]-expected)<.0001:
                                    self.assertEqual(actual[0][1:],['running','live']);return
                            except StopIteration:pass
                            page.wait_for_timeout(80)
                        self.fail('Audio graph did not reach requested gain: '+str(evaluate('popup.html',"document.querySelector('#status').textContent")))
                    volume(175);channel(1.75)
                    evaluate('popup.html',"document.querySelector('#mute').click()");channel(0)
                    evaluate('popup.html',"document.querySelector('#mute').click()");channel(1.75)
                    evaluate('popup.html',"window.dispatchEvent(new WheelEvent('wheel',{deltaY:-1,ctrlKey:true}))");channel(1.76)
                    evaluate('popup.html',"document.querySelector('#reset').click()")
                    for _ in range(60):
                        if not worker.evaluate("chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}).then(v=>v.length)"):break
                        page.wait_for_timeout(80)
                    self.assertFalse(worker.evaluate("chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}).then(v=>v.length)"))
                    volume(230);channel(2.3)
                    options=ctx.new_page()
                    options.goto(f'chrome-extension://{ext_id}/options.html')
                    self.assertTrue(options.locator('#dark').is_checked())
                    self.assertEqual(options.evaluate("getComputedStyle(document.documentElement).colorScheme"),'dark')
                    options.locator('#max').fill('150')
                    options.locator('#resetOnNavigation').check()
                    options.get_by_role('button',name='Save settings').click()
                    options.get_by_text('Settings saved.').wait_for()
                    channel(1.5)
                    page.reload()
                    for _ in range(60):
                        if not worker.evaluate("chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}).then(v=>v.length)"):break
                        page.wait_for_timeout(80)
                    self.assertFalse(worker.evaluate("chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}).then(v=>v.length)"))

                finally:ctx.close()
            finally:
                server.shutdown();server.server_close()

if __name__=='__main__':unittest.main()
