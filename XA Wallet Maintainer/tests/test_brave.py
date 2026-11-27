import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
EXT=ROOT/'extension'
BRAVE=Path(os.environ['ProgramFiles'])/'BraveSoftware/Brave-Browser/Application/brave.exe'
ALICE='0x1111111111111111111111111111111111111111'
BOB='0x2222222222222222222222222222222222222222'
HASH='0x'+'a'*64

class WalletTest(unittest.TestCase):
    def test_wallet_import_scan_and_review(self):
        spec=importlib.util.spec_from_file_location('connector_server',ROOT/'serve.py')
        mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
        server=ThreadingHTTPServer(('127.0.0.1',0),mod.Handler)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as temp,sync_playwright() as pw:
                ctx=pw.chromium.launch_persistent_context(temp,executable_path=str(BRAVE),headless=True,ignore_default_args=['--disable-extensions'],args=['--load-extension='+str(EXT),'--disable-extensions-except='+str(EXT)])
                try:
                    ctx.set_default_timeout(10000)
                    def connector_route(route):
                        url=route.request.url.replace(':43179',':'+str(server.server_port),1)
                        response=route.fetch(url=url,headers={'Host':'127.0.0.1:43179'})
                        route.fulfill(response=response)
                    ctx.route('http://127.0.0.1:43179/**',connector_route)
                    # Fixture implements only an in-memory wallet; no broadcast RPC is exposed.
                    ctx.add_init_script("""if(location.hostname==='127.0.0.1'){
                      const provider={request:async({method,params})=>{
                        if(method==='eth_chainId')return '0x1';
                        if(['eth_accounts','eth_requestAccounts'].includes(method))return ['0x1111111111111111111111111111111111111111'];
                        if(method==='eth_sendTransaction'){window.fixtureTx=params[0];if(window.fixtureAmbiguous)throw Error('Connection lost');return '0x'+'a'.repeat(64);}
                        throw Error(method);
                      }};
                      addEventListener('eip6963:requestProvider',()=>dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{info:{name:'Fixture wallet'},provider}})));
                    }""")
                    worker=ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
                    await_mock="""async(url,options)=>{
                      const method=JSON.parse(options.body).method;
                      const fixture={eth_chainId:'0x1',eth_getBalance:'0xde0b6b3a7640000',eth_gasPrice:'0x3b9aca00',eth_getCode:'0x',eth_estimateGas:'0x5208',eth_getTransactionReceipt:{status:'0x1'}};
                      if(!(method in fixture))throw Error('Unexpected RPC: '+method);
                      return new Response(JSON.stringify({result:fixture[method]}));
                    }"""
                    worker.evaluate("globalThis.fetch="+await_mock+"; true")
                    page=ctx.pages[0];page.goto(worker.url.rsplit('/',1)[0]+'/dashboard.html')
                    def route(r):
                        if r.request.method=='OPTIONS':r.fulfill(headers={'Access-Control-Allow-Origin':'*'});return
                        url=r.request.url
                        if 'blockscout' in url:result=[] if 'token-balances' in url else {'has_token_transfers':False}
                        else:
                            method=r.request.post_data_json['method']
                            result={'result':{'eth_getBalance':'0xde0b6b3a7640000','eth_getTransactionCount':'0x1'}[method]}
                        r.fulfill(json=result)
                    ctx.route('https://**/*',route)
                    with ctx.expect_page() as opened:page.locator('#connect').click()
                    connector=opened.value
                    connector.get_by_role('button',name='Connect selected wallet').click()
                    connector.get_by_role('button',name='Import connected addresses').click()
                    connector.get_by_text('Connected addresses imported into your portfolio.').wait_for()
                    connector.close()
                    page.locator('#network').select_option('eth')
                    page.locator('#scan').click()
                    page.locator('#portfolio').get_by_text('1 ETH',exact=True).wait_for()
                    page.locator('#select').click()
                    page.locator('#destination').fill(BOB)
                    with ctx.expect_page() as opened:page.locator('#plan').click()
                    signer=opened.value
                    signer.locator('#connect').click();signer.locator('#preview').click()
                    signer.locator('#quote').get_by_text(BOB,exact=True).wait_for()
                    self.assertIsNone(signer.evaluate('window.fixtureTx'))
                    signer.locator('#sign').click()
                    signer.get_by_text('Submitted: '+HASH,exact=True).wait_for()
                    tx=signer.evaluate('window.fixtureTx')
                    self.assertEqual((tx['from'],tx['to'],tx['chainId']),(ALICE,BOB,'0x1'))
                    page.locator('#check').click()
                    page.locator('#activity strong').filter(has_text='Confirmed').wait_for()
                    signer.close()
                    # A wallet error after submission can leave an unknown outcome. Do not retry it automatically.
                    page.locator('#amountMode').select_option('fixed')
                    page.locator('#fixed').fill('0.25')
                    with ctx.expect_page() as opened:page.locator('#plan').click()
                    uncertain=opened.value
                    uncertain.locator('#connect').click();uncertain.locator('#preview').click()
                    uncertain.locator('#quote').get_by_text('0.25 ETH',exact=True).wait_for()
                    uncertain.evaluate("window.fixtureAmbiguous=true")
                    uncertain.locator('#sign').click()
                    page.locator('#activity strong').filter(has_text='Unknown').wait_for()
                    uncertain.locator('#preview').click()
                    uncertain.locator('#notice').filter(has_text='pending').wait_for()
                    uncertain.close()
                    ctx.add_init_script("""if(location.hostname==='127.0.0.1'){
                        window.phantom={solana:{connect:async()=>({publicKey:{toString:()=>'4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw'}})}};
                        const evm={request:async()=>{throw Error('Solana-only Phantom account requested as Ethereum');}};
                        addEventListener('eip6963:requestProvider',()=>dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{info:{name:'Phantom'},provider:evm}})));
                    }""")
                    with ctx.expect_page() as opened:page.locator('#connect').click()
                    phantom=opened.value
                    phantom.wait_for_function("document.querySelector('#wallet').selectedOptions[0]?.textContent==='Phantom · Solana'")
                    self.assertEqual(phantom.title(),'XA Wallet Maintainer')
                    phantom.locator('#connect').click();phantom.locator('#import').click()
                    phantom.get_by_text('Connected addresses imported into your portfolio.').wait_for()
                    phantom.close()
                    sol_owner='4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw'
                    sol_dest='gCr8XkSUeFUxTpZE8HrZMGC98XdGGVyakeocBNTDibJ'
                    ctx.add_init_script('''if(location.hostname==='127.0.0.1'){
                        const a={address:'4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw',chains:['solana:mainnet']};
                        const wallet={name:'Solana fixture',version:'1.0.0',accounts:[a],chains:a.chains,features:{
                            'standard:connect':{connect:async()=>({accounts:[a]})},
                            'solana:signAndSendTransaction':{signAndSendTransaction:async({account,transaction,chain})=>{
                                if(account!==a||chain!=='solana:mainnet'||transaction.byteLength<100)throw Error('Invalid request');
                                return [{signature:new Uint8Array(64).fill(42)}];
                            }}
                        }};
                        addEventListener('wallet-standard:app-ready',e=>e.detail.register(wallet));
                    }''')
                    with ctx.expect_page() as opened:page.locator('#connect').click()
                    connected=opened.value
                    connected.locator('#wallet').select_option(label='Solana fixture · Solana')
                    connected.locator('#connect').click();connected.locator('#import').click()
                    connected.get_by_text('Connected addresses imported into your portfolio.').wait_for()
                    connected.close()
                    def sol_route(r):
                        method=r.request.post_data_json['method']
                        value={'getBalance':{'value':10000000},'getTokenAccountsByOwner':{'value':[]},'getSignaturesForAddress':[{}]}[method]
                        r.fulfill(json={'result':value})
                    ctx.route('https://api.mainnet-beta.solana.com/**',sol_route)
                    page.locator('#network').select_option('sol');page.locator('#scan').click()
                    page.locator('#portfolio').get_by_text('0.01 SOL',exact=True).wait_for()
                    page.locator('#select').click();page.locator('#amountMode').select_option('sweep');page.locator('#destination').fill(sol_dest)
                    worker.evaluate('''globalThis.fetch=async(url,options)=>{
                      const method=JSON.parse(options.body).method;
                      const answers={getGenesisHash:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
                        getBalance:{value:10000000},getAccountInfo:{value:null},getLatestBlockhash:{value:{blockhash:'32akzZ4eJcC1kGphx6pENrhT2JjejYENkuyvmnGSAP3S',lastValidBlockHeight:420}},
                        getFeeForMessage:{value:5000},simulateTransaction:{value:{err:null}},getSignatureStatuses:{value:[{confirmationStatus:'confirmed',err:null}]}};
                      if(!(method in answers))throw Error(method);
                      return Response.json({result:answers[method]});
                    };true''')
                    with ctx.expect_page() as opened:page.locator('#plan').click()
                    sol=opened.value
                    sol.locator('#wallet').select_option(label='Solana fixture · Solana')
                    sol.locator('#connect').click();sol.locator('#preview').click()
                    sol.locator('#quote').get_by_text('0.009995 SOL',exact=True).wait_for()
                    sol.locator('#sign').click()
                    sol.locator('#notice').filter(has_text='Submitted').wait_for()
                    page.locator('#check').click()
                    page.locator('#activity strong').filter(has_text='Confirmed · 0.009995 SOL').wait_for()
                finally:ctx.close()
        finally:server.shutdown();server.server_close()

if __name__=='__main__':unittest.main()
