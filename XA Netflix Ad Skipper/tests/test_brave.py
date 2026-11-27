import io
import json
import wave
import os
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

extension = Path(__file__).resolve().parents[1] / "extension"
brave = Path(os.environ["ProgramFiles"]) / "BraveSoftware/Brave-Browser/Application/brave.exe"
controls = ["player-skip-intro", "player-skip-recap", "next-episode-seamless-button", "interrupt-autoplay-continue"]
buttons = "".join(f'<button data-uia="{key}" onclick="this.value++" value="0">{key}</button>' for key in controls)
fixture = "<video></video>" + buttons + '<button data-uia="control-next" value="0" onclick="this.value++">Next</button>'

with tempfile.TemporaryDirectory() as profile, sync_playwright() as pw:
    ctx = pw.chromium.launch_persistent_context(profile, executable_path=str(brave), headless=True,
        ignore_default_args=["--disable-extensions"], args=[f"--load-extension={extension}", f"--disable-extensions-except={extension}"])
    try:
        manager = ctx.pages[0]
        manager.goto("brave://extensions/")
        info = manager.evaluate("() => chrome.developerPrivate.getExtensionsInfo()")
        ext_id = next(item["id"] for item in info if item["name"] == "XA Netflix Ad Skipper")
        popup = ctx.new_page()
        popup.goto(f"chrome-extension://{ext_id}/popup.html")
        ctx.route("https://www.netflix.com/**", lambda route: route.fulfill(content_type="text/html", body=fixture))
        page = ctx.new_page()
        page.goto("https://www.netflix.com/watch/123")
        # Open the popup document while the watch tab is active, as with the toolbar action.
        page.bring_to_front()
        popup.reload()
        streams = [{"res_h": height, "bitrate": rate} for height, rate in [(480, 600), (720, 1200), (720, 1800), (1080, 3500)]]
        manifest = {"result": {"video_tracks": [{"streams": streams}], "audio_tracks": ["original"]}}
        parse = "s => JSON.parse(s)"
        payload = json.dumps(manifest)
        assert page.evaluate(parse, payload) == manifest
        for choice, expected in [("720", [720, 720]), ("highest", [1080]), ("2160", [1080]), ("480", [480]), ("auto", [480, 720, 720, 1080])]:
            with page.expect_navigation(timeout=6000):
                popup.locator("#quality").select_option(choice)
            popup.wait_for_function("async choice => (await chrome.storage.local.get('quality')).quality === choice", arg=choice)
            page.wait_for_function("([s, heights]) => JSON.stringify(JSON.parse(s).result.video_tracks[0].streams.map(x => x.res_h)) === JSON.stringify(heights)", arg=[payload, expected])
            selected = page.evaluate("s => new Response(s).json()", payload)["result"]
            assert selected["video_tracks"][0]["streams"] == [stream for stream in streams if stream["res_h"] in expected]
            modern = {"videoTracks": [{"downloadables": [{"height": h} for h in [480, 720, 1080]]}]}
            actual = page.evaluate(parse, json.dumps(modern))["videoTracks"][0]["downloadables"]
            assert [d["height"] for d in actual] == sorted(set(expected))
            if choice != "auto":
                expect(popup.locator("#playing")).to_contain_text(f"Stream list selected {expected[0]}p")
            assert selected["audio_tracks"] == ["original"]
        for key in controls:
            expect(page.locator(f'[data-uia="{key}"]')).to_have_attribute("value", "1")
        expect(page.locator('[data-uia="control-next"]')).to_have_attribute("value", "0")
        popup.locator("#intro").uncheck()
        popup.reload()
        expect(popup.locator("#intro")).not_to_be_checked()
        page.reload()
        expect(page.locator(f'[data-uia="{controls[1]}"]')).to_have_attribute("value", "1")
        expect(page.locator(f'[data-uia="{controls[0]}"]')).to_have_attribute("value", "0")
        popup.locator("#intro").check()
        expect(page.locator(f'[data-uia="{controls[0]}"]')).to_have_attribute("value", "1")
        page.evaluate("""window.v = document.querySelector('video'); v.playbackRate = 1.5;
            window.marker = document.createElement('div'); marker.textContent='Ad 0:30'; marker.className='forward-anim';
            document.body.append(marker)""")
        fast = "v.muted && v.playbackRate === 8 && v.style.visibility === 'hidden'"
        normal = "!v.muted && v.playbackRate === 1.5 && !v.style.visibility"
        page.wait_for_function(fast)
        popup.locator("#ads").uncheck()
        page.wait_for_function(normal)
        popup.locator("#ads").check()
        page.wait_for_function(fast)
        page.evaluate("marker.firstChild.data = 'Ad 0:01'")
        page.wait_for_function(normal)
        page.evaluate("marker.firstChild.data = 'Ad 0:15'")
        page.wait_for_timeout(850)
        assert page.evaluate(normal), "A lingering badge reaccelerated playback"
        page.evaluate("marker.remove()")
        page.wait_for_timeout(100)
        page.evaluate("marker.textContent = 'Ad'; document.body.append(marker)")
        page.wait_for_timeout(150)
        assert page.evaluate(normal), "An untimed badge accelerated playback"
        page.evaluate("marker.firstChild.data = 'Ad 0:30'")
        page.wait_for_function(fast)
        page.evaluate("marker.firstChild.data = 'Ad'")
        page.wait_for_function(normal)
        page.evaluate("marker.remove()")
        page.wait_for_function(normal)
        page.evaluate("""window.timer = document.createElement('span'); timer.textContent = '0:01';
            document.body.append(marker, timer)""")
        page.wait_for_timeout(120)
        assert page.evaluate(normal), "A sibling countdown at one second accelerated"
        page.evaluate("marker.remove(); timer.remove()")
        page.wait_for_timeout(100)
        page.evaluate("document.body.append(marker)")
        page.evaluate("marker.firstChild.data = 'Ad 0:06'")
        page.wait_for_function(fast)
        page.wait_for_function(normal, timeout=1700)
        page.evaluate("marker.remove()")
        page.wait_for_function(normal)
        # Play an actual media timeline. Keep the simulated badge stale across the
        # six-second ad boundary and verify the entire last second and show opening.
        audio = io.BytesIO()
        with wave.open(audio, "wb") as wav:
            wav.setparams((1, 1, 8000, 0, "NONE", "not compressed"))
            wav.writeframes(bytes([128]) * 8000 * 10)
        page.route("**/sample.wav", lambda r: r.fulfill(content_type="audio/wav", body=audio.getvalue()))
        page.evaluate("v.src = '/sample.wav'; v.load()")
        page.wait_for_function("v.readyState >= 2")
        page.evaluate("""v.playbackRate = 1; window.samples = [];
            v.addEventListener('timeupdate', () => samples.push([v.currentTime, v.playbackRate, v.muted, v.style.visibility]));
            marker.textContent = 'Ad 0:06'; document.body.append(marker); v.play()""")
        page.wait_for_function(fast)
        page.wait_for_function("v.currentTime > 6.5")
        tail = page.evaluate("samples.filter(([t]) => t >= 5 && t < 6.5)")
        assert len(tail) >= 3 and all(row[1:] == [1, False, ""] for row in tail), tail
        # Pre-roll and mid-roll on one title, with the same Netflix timer element.
        page.goto("https://www.netflix.com/watch/456")
        page.evaluate("""window.v = document.querySelector('video'); v.playbackRate = 1.5;
            window.timer = document.createElement('span'); timer.className = 'default-ltr-cache-mmvz9h';
            timer.textContent = '30'; document.body.append(timer)""")
        page.wait_for_function(fast)
        page.evaluate("timer.textContent = '2'")
        page.wait_for_function(normal)
        page.evaluate("timer.textContent = ''")
        page.wait_for_timeout(100)
        page.evaluate("timer.textContent = '18'")
        page.wait_for_timeout(100)
        page.evaluate("timer.textContent = '17'")
        page.wait_for_function(fast)
        page.evaluate("timer.textContent = '1'")
        page.wait_for_function(normal)
        page.goto("https://www.netflix.com/browse")
        page.wait_for_timeout(900)
        expect(page.locator(f'[data-uia="{controls[0]}"]')).to_have_attribute("value", "0")
        print("Brave playback and popup checks passed.")
    finally:
        ctx.close()

