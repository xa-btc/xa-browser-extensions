"""Serve the packaged wallet connector only on the local loopback interface."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.client import HTTPConnection, HTTPException
from pathlib import Path
ROOT=Path(__file__).resolve().parent
FILES={'/':('connector/index.html','text/html; charset=utf-8'),'/signer.js':('connector/signer.js','text/javascript'),'/style.css':('extension/style.css','text/css'),'/icon.png':('extension/icons/48.png','image/png')}
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get('Host')!='127.0.0.1:43179' or self.path not in FILES:
            self.send_error(404);return
        name,kind=FILES[self.path]
        payload=(ROOT/name).read_bytes()
        self.send_response(200)
        self.send_header('Content-Type',kind)
        self.send_header('Content-Length',str(len(payload)))
        self.send_header('Cache-Control','no-store')
        self.send_header('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('X-Content-Type-Options','nosniff')
        self.end_headers();self.wfile.write(payload)
if __name__=='__main__':
    probe=HTTPConnection('127.0.0.1',43179,timeout=1)
    try:
        probe.request('GET','/')
        reply=probe.getresponse()
        expected=(ROOT/'connector/index.html').read_bytes()
        if reply.status==200 and reply.read(len(expected)+1)==expected:
            print('XA Wallet Maintainer is already running. Continue in Brave.')
            raise SystemExit(0)
    except (OSError,HTTPException):
        pass
    finally:
        probe.close()
    with ThreadingHTTPServer(('127.0.0.1',43179),Handler) as server:
        print('XA Wallet Maintainer is listening at http://127.0.0.1:43179. Open Connect wallet or Review selected transfers in XA Wallet Maintainer. Press Ctrl+C to stop.',flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
