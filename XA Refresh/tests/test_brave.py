import functools
import http.server
import os
import tempfile
import threading
import unittest
from pathlib import Path
from playwright.sync_api import sync_playwright

EXT = Path(__file__).resolve().parents[1] / 'extension'
BRAVE = Path(os.environ['ProgramFiles']) / 'BraveSoftware/Brave-Browser/Application/brave.exe'

class RefreshTest(unittest.TestCase):
    def test_popup_timer_and_monitor(self):
        with tempfile.TemporaryDirectory() as tmp, sync_playwright() as pw:
            page_file = Path(tmp) / 'index.html'
            page_file.write_text('<title>XR fixture</title><p>Waiting</p>')
            handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=tmp)
            server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                ctx = pw.chromium.launch_persistent_context(str(Path(tmp)/'profile'),executable_path=str(BRAVE),headless=True,
                    ignore_default_args=['--disable-extensions'],args=['--load-extension='+str(EXT),'--disable-extensions-except='+str(EXT),'--accept-extension-permission-request'])
                try:
                    site = ctx.pages[0]
                    site.goto(f'http://127.0.0.1:{server.server_port}/index.html')
                    worker = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
                    base = worker.url.rsplit('/',1)[0]
                    popup = ctx.new_page()
                    site.bring_to_front()
                    popup.goto(base+'/popup.html')
                    popup.get_by_text('XR fixture',exact=True).wait_for()
                    popup.locator('[name=seconds]').fill('1')
                    popup.locator('[name=mode]').select_option('once')
                    popup.locator('#start').click()
                    center = ctx.new_page()
                    center.goto(base+'/center.html')
                    center.get_by_text('Refresh schedule completed.',exact=False).last.wait_for()
                    self.assertGreater(site.evaluate("performance.getEntriesByType('navigation').filter(e=>e.type==='reload').length"),0)
                    popup.locator('[name=mode]').select_option('fixed')
                    permissions = ctx.new_page()
                    permissions.goto('brave://extensions')
                    permissions.evaluate("id=>chrome.developerPrivate.addHostPermission(id,'http://127.0.0.1/*')",base.rsplit('/',1)[-1])
                    permissions.close()
                    popup.locator('[name=monitor]').select_option('change')
                    popup.locator('[name=notify]').uncheck()
                    popup.locator('#start').click()
                    popup.locator('#stop').wait_for(timeout=5000)
                    page_file.write_text('<title>XR fixture</title><p>Available now</p>')
                    center.get_by_text('Page content changed.',exact=False).last.wait_for()
                    center.get_by_text('No active timers.').wait_for()
                    self.assertIn('Page content changed.',center.locator('#events').inner_text())
                finally:
                    ctx.close()
            finally:
                server.shutdown()
                server.server_close()

if __name__=='__main__':
    unittest.main()
