"""
Automated checks for Tambola Caller (spec section 9).
Runs the real page in headless Chromium with a fake clock and a recording
speech engine, so a full 90-number game takes seconds.

    pip install playwright && playwright install chromium
    python tests/test_caller.py
"""
import pathlib
import sys
from playwright.sync_api import sync_playwright

SITE = (pathlib.Path(__file__).resolve().parent.parent / "site" / "index.html").as_uri()
SPEECH_MS = 1500  # how long the fake engine "speaks" each line

FAKE_SPEECH = """
(() => {
  const log = { spoken: [], overlaps: 0, speaking: null };
  window.__speech = log;
  class FakeUtterance { constructor(t) { this.text = t; } }
  const synth = {
    paused: false, pending: false, speaking: false,
    getVoices: () => [{ name: 'Test India', lang: 'en-IN', voiceURI: 'test-in', localService: true, default: true }],
    addEventListener() {}, removeEventListener() {},
    speak(u) {
      if (log.speaking) log.overlaps++;
      log.speaking = u; this.speaking = true;
      log.spoken.push(u.text);
      setTimeout(() => { if (log.speaking === u && u.onstart) u.onstart({}); }, 10);
      setTimeout(() => {
        if (log.speaking === u) { log.speaking = null; synth.speaking = false; if (u.onend) u.onend({}); }
      }, %d);
    },
    cancel() {
      const u = log.speaking;
      log.speaking = null; this.speaking = false;
      if (u && u.onerror) setTimeout(() => u.onerror({ error: 'interrupted' }), 0);
    },
    pause() {}, resume() {}
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: FakeUtterance, configurable: true });
})();
""" % SPEECH_MS

NO_SPEECH = """
Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });
Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: undefined, configurable: true });
"""

failures = []


def check(cond, msg):
    print(("PASS  " if cond else "FAIL  ") + msg)
    if not cond:
        failures.append(msg)


def text(page, sel):
    return page.locator(sel).inner_text().strip()


def called(page):
    return [int(x) for x in page.locator("#history .num").all_inner_texts()]


def green(page):
    return sorted(int(x) for x in page.locator(".cell.is-called").all_inner_texts())


def spoken_calls(page):
    return [s for s in page.evaluate("window.__speech.spoken") if s.startswith("Next number is")]


def new_page(browser, script=FAKE_SPEECH):
    ctx = browser.new_context(viewport={"width": 1366, "height": 768})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.clock.install()
    page.add_init_script(script)
    page.route("https://fonts.googleapis.com/**", lambda r: r.fulfill(status=200, body="", content_type="text/css"))
    page.goto(SITE)
    return ctx, page, errors


def run(page, ms):
    page.clock.run_for(ms)


with sync_playwright() as p:
    browser = p.chromium.launch()

    # 1. Board
    ctx, page, errors = new_page(browser)
    nums = [int(x) for x in page.locator("#board .cell").all_inner_texts()]
    check(nums == list(range(1, 91)), "1. Board has exactly 90 cells, 1 to 90 in order")
    cols = page.evaluate("getComputedStyle(document.getElementById('board')).gridTemplateColumns.split(' ').length")
    check(cols == 10, "1. Board is 10 columns (so 9 rows)")
    check(text(page, "#countdown") == "10" and text(page, "#called-count") == "0", "   Idle state shows 0 called, countdown 10")
    check(page.locator("#btn-next").is_disabled() and page.locator("#btn-pause").is_disabled(), "   Next and Pause disabled before start")

    # 2 + 4. Start, first call, countdown, auto call
    page.click("#btn-start")
    run(page, 100)
    first = called(page)
    check(len(first) == 1 and green(page) == first, "2. First number called on Start and its cell is green")
    check(text(page, "#current-number") == str(first[0]), "   Current-number panel shows it")
    check(page.locator("#btn-next").is_disabled(), "   Call Next disabled while announcing")
    run(page, SPEECH_MS + 200)
    check(text(page, "#countdown") == "10", "4. Countdown starts at 10 after the announcement ends")
    run(page, 4000)
    check(text(page, "#countdown") == "6", "4. Countdown ticks down (6 after 4 s)")
    run(page, 6000 - 100)
    check(len(called(page)) == 2, "4. Next number called automatically when countdown hits 0")

    # 5. Pause and resume
    run(page, SPEECH_MS + 3000)
    before = called(page)
    page.click("#btn-pause")
    cd = text(page, "#countdown")
    run(page, 60000)
    check(called(page) == before and text(page, "#countdown") == cd, "5. Pause holds progress and countdown (" + cd + " s) for 60 s")
    page.click("#btn-resume")
    run(page, 6000)
    check(len(called(page)) == len(before), "5. Resume continues from remaining time, not from 10")
    run(page, 1100)
    check(len(called(page)) == len(before) + 1, "5. Call happens when the remaining time runs out")

    # 6. Repeat
    run(page, SPEECH_MS + 100)
    before = called(page)
    page.click("#btn-repeat")
    run(page, SPEECH_MS + 100)
    sp = page.evaluate("window.__speech.spoken")
    check(sp[-1].startswith("Repeat. The last number was " + str(before[-1])), "6. Repeat speaks the last number")
    check(called(page) == before and green(page) == sorted(before), "6. Repeat does not add a call or change the board")

    # 7 + 11. Manual next and rapid clicks
    run(page, 200)
    page.evaluate("for (let i = 0; i < 25; i++) document.getElementById('btn-next').click()")
    run(page, 50)
    after = called(page)
    check(len(after) == len(before) + 1, "11. 25 rapid Call Next clicks make exactly one call")
    check(len(set(after)) == len(after), "7. Manual call introduced no duplicate")
    run(page, SPEECH_MS + 100)
    page.evaluate("for (let i = 0; i < 20; i++) { document.getElementById('btn-pause').click(); document.getElementById('btn-resume').click(); document.getElementById('btn-start').click(); }")
    n0 = len(called(page))
    run(page, 10000 * 5 + SPEECH_MS * 5 + 500)
    check(len(called(page)) - n0 == 5, "11. Spamming Start/Pause/Resume leaves one timer (5 calls in 5 cycles)")
    check(page.evaluate("window.__speech.overlaps") == 0, "10. No overlapping speech so far")

    # 3 + 9. Play to the end
    run(page, 95 * (10000 + SPEECH_MS + 200))
    allc = called(page)
    check(len(allc) == 90 and sorted(allc) == list(range(1, 91)), "3. All 90 numbers called, each exactly once")
    check(green(page) == list(range(1, 91)), "2. Every called number is green on the board")
    check(text(page, "#called-count") == "90" and text(page, "#remaining-count") == "0", "   Counters read 90 / 90 and 0 remaining")
    check(text(page, "#status-line") == "All 90 numbers have been called!", "9. Completion message shown")
    check(page.locator("#btn-next").is_disabled() and page.locator("#btn-pause").is_disabled()
          and page.locator("#btn-start").is_disabled(), "9. Calling stops and controls are disabled")
    calls = spoken_calls(page)
    check(len(calls) == 90 and len(set(calls)) == 90, "10. Exactly 90 number announcements, none repeated")
    check([int(s.split()[-1].rstrip('.')) for s in calls] == allc, "   Spoken order matches history order")
    check(page.evaluate("window.__speech.overlaps") == 0, "10. No overlapping speech in a full game")
    run(page, 60000)
    check(len(called(page)) == 90, "9. Nothing else happens after completion")

    # 8. Reset with confirmation
    page.click("#btn-reset")
    check(page.locator("#reset-dialog").is_visible(), "8. Reset asks for confirmation")
    page.click("#reset-cancel")
    check(len(called(page)) == 90, "8. Cancel keeps the game")
    page.click("#btn-reset")
    page.click("#reset-confirm")
    run(page, 100)
    check(called(page) == [] and green(page) == [] and text(page, "#current-number") == "--"
          and text(page, "#called-count") == "0" and text(page, "#remaining-count") == "90"
          and text(page, "#countdown") == "10", "8. Reset clears board, history, counters and current number")
    check(not page.locator("#btn-start").is_disabled(), "8. Start is available again")
    page.click("#btn-start")
    run(page, 100)
    check(len(called(page)) == 1, "8. New game starts after reset")

    # Reset mid-announcement cancels speech and stops the timer
    page.click("#btn-reset")
    page.click("#reset-confirm")
    run(page, 30000)
    check(called(page) == [], "8. Reset during an announcement stops everything")
    check(errors == [], "   No console errors (" + "; ".join(errors[:3]) + ")")
    ctx.close()

    # Mute
    ctx, page, errors = new_page(browser)
    page.click("#btn-mute")
    check(text(page, "#btn-mute") == "Unmute", "Mute button toggles to Unmute")
    page.click("#btn-start")
    run(page, 3 * 10000 + 500)
    check(len(called(page)) == 4 and spoken_calls(page) == [], "Muted game keeps calling with no speech")
    page.click("#btn-pause")
    page.click("#btn-test")
    run(page, 100)
    check(page.evaluate("window.__speech.spoken").count("Voice test. Next number is 42.") == 1, "Test Voice speaks even when muted")
    ctx.close()

    # Unsupported speech
    ctx, page, errors = new_page(browser, NO_SPEECH)
    check(page.locator("#speech-warning").is_visible(), "Warning shown when the browser has no speech support")
    page.click("#btn-start")
    run(page, 2 * 10000 + 500)
    check(len(called(page)) == 3, "Game still runs without speech support")
    check(errors == [], "   No console errors without speech")
    ctx.close()

    # Many games: shuffle never repeats and covers 1..90
    ctx, page, errors = new_page(browser)
    page.click("#btn-mute")
    ok = True
    for g in range(20):
        page.click("#btn-start")
        for _ in range(89):  # Start already made the first call
            run(page, 10)
            page.click("#btn-next")
        run(page, 50)
        c = called(page)
        if sorted(c) != list(range(1, 91)):
            ok = False
        page.click("#btn-reset")
        page.click("#reset-confirm")
    check(ok, "3. 20 back-to-back games via Call Next: always 90 unique numbers")
    ctx.close()

    # Layout: phone width has no horizontal scroll; desktop keeps panel in view
    for w, h in [(390, 844), (768, 1024), (1366, 768)]:
        ctx = browser.new_context(viewport={"width": w, "height": h})
        page = ctx.new_page()
        page.add_init_script(FAKE_SPEECH)
        page.goto(SITE)
        sw = page.evaluate("document.documentElement.scrollWidth")
        check(sw <= w, "Layout at %dpx wide has no horizontal scroll (%d)" % (w, sw))
        if w == 1366:
            page.mouse.wheel(0, 2000)
            page.wait_for_timeout(200)
            box = page.locator("#countdown").bounding_box()
            box2 = page.locator("#current-number").bounding_box()
            check(box and box2 and 0 <= box["y"] < h and 0 <= box2["y"] < h,
                  "Current number and countdown stay visible after scrolling on desktop")
        page.screenshot(path="/tmp/claude-0/-home-claude/802e9794-cc07-5ed1-a5df-f0d9b8af9bf6/scratchpad/shot-%d.png" % w, full_page=False)
        ctx.close()

    browser.close()

print()
print("All checks passed." if not failures else "%d check(s) failed." % len(failures))
sys.exit(1 if failures else 0)
