/*
 * Tambola Caller
 * Every game draws from one Fisher-Yates shuffle of 1..90, so each number
 * can be called once and only once until the user resets the game.
 */
(function () {
  'use strict';

  var TOTAL = 90;
  var INTERVAL_MS = 10000;
  var TICK_MS = 100;
  var STORAGE_KEY = 'tambola-caller-settings';

  /* ---------- Randomness ---------- */

  // Unbiased integer in [0, maxExclusive) using rejection sampling.
  function randomIndex(maxExclusive) {
    var cryptoObj = window.crypto || window.msCrypto;
    if (cryptoObj && cryptoObj.getRandomValues) {
      var buf = new Uint32Array(1);
      var limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
      var x;
      do {
        cryptoObj.getRandomValues(buf);
        x = buf[0];
      } while (x >= limit);
      return x % maxExclusive;
    }
    return Math.floor(Math.random() * maxExclusive);
  }

  function shuffledPool() {
    var pool = [];
    for (var n = 1; n <= TOTAL; n++) pool.push(n);
    for (var i = pool.length - 1; i > 0; i--) {
      var j = randomIndex(i + 1);
      var tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    return pool;
  }

  function isValidNumber(n) {
    return Number.isInteger(n) && n >= 1 && n <= TOTAL;
  }

  /* ---------- State ---------- */

  var state = {
    status: 'idle',          // 'idle' | 'running' | 'complete'
    paused: false,
    announcing: false,
    numberPool: shuffledPool(),
    calledNumbers: [],
    calledSet: new Set(),
    currentNumber: null,
    countdown: 10,
    remainingMs: INTERVAL_MS
  };

  var timer = { id: null, deadline: 0 };

  var speech = {
    supported: typeof window.speechSynthesis !== 'undefined' &&
      typeof window.SpeechSynthesisUtterance !== 'undefined',
    token: 0,
    finish: null,
    delayId: null,
    fallbackId: null,
    utterance: null,
    voices: [],
    voiceURI: '',
    rate: 0.9,
    volume: 1,
    muted: false,
    label: ''
  };

  /* ---------- Elements ---------- */

  function $(id) { return document.getElementById(id); }

  var el = {
    board: $('board'),
    ball: $('current-ball'),
    current: $('current-number'),
    status: $('status-line'),
    called: $('called-count'),
    remaining: $('remaining-count'),
    countdown: $('countdown'),
    fill: $('timer-fill'),
    history: $('history'),
    historyMeta: $('history-meta'),
    warning: $('speech-warning'),
    start: $('btn-start'),
    pause: $('btn-pause'),
    resume: $('btn-resume'),
    next: $('btn-next'),
    repeat: $('btn-repeat'),
    mute: $('btn-mute'),
    reset: $('btn-reset'),
    test: $('btn-test'),
    testHint: $('test-hint'),
    voiceSelect: $('voice-select'),
    rate: $('rate-input'),
    rateOut: $('rate-output'),
    volume: $('volume-input'),
    volumeOut: $('volume-output'),
    dialog: $('reset-dialog'),
    resetCancel: $('reset-cancel'),
    resetConfirm: $('reset-confirm')
  };

  var cells = {};

  /* ---------- Timer (single interval, deadline based) ---------- */

  function stopTimer() {
    if (timer.id !== null) {
      clearInterval(timer.id);
      timer.id = null;
    }
  }

  function startCountdown(ms) {
    stopTimer();
    state.remainingMs = ms;
    state.countdown = Math.ceil(ms / 1000);
    timer.deadline = performance.now() + ms;
    timer.id = setInterval(tick, TICK_MS);
    renderCountdown();
  }

  function tick() {
    if (state.status !== 'running' || state.paused || state.announcing) {
      stopTimer();
      return;
    }
    var rem = timer.deadline - performance.now();
    if (rem <= 0) {
      stopTimer();
      state.remainingMs = 0;
      state.countdown = 0;
      renderCountdown();
      callNext();
      return;
    }
    state.remainingMs = rem;
    state.countdown = Math.ceil(rem / 1000);
    renderCountdown();
  }

  /* ---------- Speech ---------- */

  function clearSpeechTimers() {
    if (speech.delayId !== null) { clearTimeout(speech.delayId); speech.delayId = null; }
    if (speech.fallbackId !== null) { clearTimeout(speech.fallbackId); speech.fallbackId = null; }
  }

  function selectedVoice() {
    if (!speech.voiceURI) return null;
    for (var i = 0; i < speech.voices.length; i++) {
      if (speech.voices[i].voiceURI === speech.voiceURI) return speech.voices[i];
    }
    return null;
  }

  // Speaks one line. Any earlier speech is cancelled first, and onDone runs
  // exactly once when this line ends, unless something newer replaces it.
  function speak(text, label, onDone, force) {
    speech.token += 1;
    var token = speech.token;
    var finished = false;
    clearSpeechTimers();
    if (speech.supported) window.speechSynthesis.cancel();

    state.announcing = true;
    speech.label = label;
    render();

    function done() {
      if (finished || token !== speech.token) return;
      finished = true;
      clearSpeechTimers();
      speech.finish = null;
      speech.utterance = null;
      state.announcing = false;
      render();
      if (onDone) onDone();
    }
    speech.finish = done;

    if (!speech.supported || (speech.muted && !force)) {
      speech.delayId = setTimeout(done, 0);
      return;
    }

    // A short gap after cancel() avoids Chrome dropping the next utterance.
    speech.delayId = setTimeout(function () {
      speech.delayId = null;
      if (finished || token !== speech.token) return;
      if (speech.muted && !force) { done(); return; }
      var u = new SpeechSynthesisUtterance(text);
      var voice = selectedVoice();
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      }
      u.rate = speech.rate;
      u.volume = speech.volume;
      u.pitch = 1;
      u.onend = done;
      u.onerror = done;
      u.onstart = function () {
        if (finished || token !== speech.token) return;
        if (speech.fallbackId !== null) clearTimeout(speech.fallbackId);
        speech.fallbackId = setTimeout(done, 2500 + (text.length * 160) / speech.rate);
      };
      speech.utterance = u; // keep a reference so the browser does not drop events
      window.speechSynthesis.speak(u);
      if (window.speechSynthesis.paused) window.speechSynthesis.resume();
      // Safety net if the engine never reports start or end.
      speech.fallbackId = setTimeout(done, 9000);
    }, 60);
  }

  function cancelSpeech() {
    speech.token += 1;
    clearSpeechTimers();
    speech.finish = null;
    speech.utterance = null;
    if (speech.supported) window.speechSynthesis.cancel();
    state.announcing = false;
  }

  /* ---------- Game actions ---------- */

  function callNext() {
    if (state.status !== 'running' || state.announcing) return false;

    stopTimer();

    var n = null;
    while (state.numberPool.length > 0) {
      var candidate = state.numberPool.pop();
      if (isValidNumber(candidate) && !state.calledSet.has(candidate)) {
        n = candidate;
        break;
      }
      // Unreachable with a correct shuffle; logged so it can never pass silently.
      console.error('Rejected invalid or repeated number from pool:', candidate);
    }

    if (n === null) {
      finishGame();
      return false;
    }

    state.calledSet.add(n);
    state.calledNumbers.push(n);
    state.currentNumber = n;
    state.remainingMs = INTERVAL_MS;
    state.countdown = INTERVAL_MS / 1000;

    renderCall(n);
    speak('Next number is ' + n + '.', 'Announcing ' + n + '.', afterCall);
    return true;
  }

  function afterCall() {
    if (state.status !== 'running') return;
    if (state.numberPool.length === 0) {
      finishGame();
      return;
    }
    state.remainingMs = INTERVAL_MS;
    if (state.paused) {
      state.countdown = INTERVAL_MS / 1000;
      render();
    } else {
      startCountdown(INTERVAL_MS);
    }
  }

  function finishGame() {
    stopTimer();
    state.status = 'complete';
    state.paused = false;
    state.remainingMs = 0;
    state.countdown = 0;
    render();
    speak('All 90 numbers have been called.', 'All 90 numbers have been called!', null);
  }

  function startGame() {
    if (state.status !== 'idle') return;
    state.status = 'running';
    state.paused = false;
    callNext();
  }

  function pauseGame() {
    if (state.status !== 'running' || state.paused) return;
    state.paused = true;
    if (timer.id !== null) {
      state.remainingMs = Math.max(timer.deadline - performance.now(), 0);
      stopTimer();
    }
    state.countdown = Math.ceil(state.remainingMs / 1000);
    render();
  }

  function resumeGame() {
    if (state.status !== 'running' || !state.paused) return;
    state.paused = false;
    if (!state.announcing) {
      startCountdown(state.remainingMs > 0 ? state.remainingMs : INTERVAL_MS);
    }
    render();
  }

  function repeatLast() {
    if (state.currentNumber === null || state.announcing) return;
    var n = state.currentNumber;
    var wasCounting = state.status === 'running' && !state.paused && timer.id !== null;
    if (wasCounting) {
      state.remainingMs = Math.max(timer.deadline - performance.now(), 0);
      stopTimer();
    }
    speak('Repeat. The last number was ' + n + '.', 'Repeating ' + n + '.', function () {
      if (wasCounting && state.status === 'running' && !state.paused) {
        startCountdown(Math.max(state.remainingMs, 1000));
      }
    });
  }

  function testVoice() {
    if (!speech.supported || state.announcing || isCounting()) return;
    speak('Voice test. Next number is 42.', 'Testing the voice.', null, true);
  }

  function toggleMute() {
    speech.muted = !speech.muted;
    saveSettings();
    if (speech.muted && state.announcing && speech.supported) {
      window.speechSynthesis.cancel();
      if (speech.finish) speech.finish();
    }
    render();
  }

  function resetGame() {
    stopTimer();
    cancelSpeech();
    state.status = 'idle';
    state.paused = false;
    state.numberPool = shuffledPool();
    state.calledNumbers = [];
    state.calledSet = new Set();
    state.currentNumber = null;
    state.remainingMs = INTERVAL_MS;
    state.countdown = INTERVAL_MS / 1000;

    for (var n = 1; n <= TOTAL; n++) {
      cells[n].classList.remove('is-called', 'is-current', 'flash');
      cells[n].setAttribute('aria-label', n + ', not called');
    }
    el.history.textContent = '';
    el.current.textContent = '--';
    el.ball.classList.remove('is-live', 'pop');
    render();
  }

  function isCounting() {
    return state.status === 'running' && !state.paused;
  }

  /* ---------- Rendering ---------- */

  function buildBoard() {
    var frag = document.createDocumentFragment();
    for (var n = 1; n <= TOTAL; n++) {
      var li = document.createElement('li');
      li.className = 'cell';
      li.id = 'cell-' + n;
      li.textContent = String(n);
      li.setAttribute('aria-label', n + ', not called');
      cells[n] = li;
      frag.appendChild(li);
    }
    el.board.appendChild(frag);
  }

  function restartAnimation(node, cls) {
    node.classList.remove(cls);
    void node.offsetWidth; // reflow so the animation plays again
    node.classList.add(cls);
  }

  function renderCall(n) {
    var prev = el.board.querySelector('.is-current');
    if (prev) prev.classList.remove('is-current');

    var cell = cells[n];
    cell.classList.add('is-called', 'is-current');
    cell.setAttribute('aria-label', n + ', called');
    restartAnimation(cell, 'flash');

    el.current.textContent = String(n);
    el.ball.classList.add('is-live');
    restartAnimation(el.ball, 'pop');

    var li = document.createElement('li');
    var seq = document.createElement('span');
    seq.className = 'seq';
    seq.textContent = state.calledNumbers.length + '.';
    var num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(n);
    li.appendChild(seq);
    li.appendChild(num);
    el.history.appendChild(li);

    render();
  }

  function renderCountdown() {
    el.countdown.textContent = String(state.countdown);
    var frac = Math.min(Math.max(state.remainingMs / INTERVAL_MS, 0), 1);
    el.fill.style.transform = 'scaleX(' + frac + ')';
  }

  function statusText() {
    if (state.status === 'complete') {
      return state.announcing && speech.label !== 'All 90 numbers have been called!'
        ? speech.label
        : 'All 90 numbers have been called!';
    }
    if (state.announcing) return speech.label;
    if (state.status === 'idle') return 'Press Start Game to call the first number.';
    if (state.paused) return 'Paused. Press Resume to continue.';
    return 'A new number is called every 10 seconds.';
  }

  function render() {
    var count = state.calledNumbers.length;
    el.called.textContent = String(count);
    el.remaining.textContent = String(TOTAL - count);
    renderCountdown();

    el.status.textContent = statusText();
    el.status.classList.toggle('is-complete', state.status === 'complete');

    el.historyMeta.textContent = count === 0
      ? 'No numbers called yet.'
      : 'In the order called, first to latest.';

    var running = state.status === 'running';
    el.start.disabled = state.status !== 'idle';
    el.pause.disabled = !running || state.paused;
    el.resume.disabled = !running || !state.paused;
    el.next.disabled = !running || state.announcing;
    el.repeat.disabled = state.currentNumber === null || state.announcing;
    el.reset.disabled = state.status === 'idle' && count === 0;

    el.mute.disabled = !speech.supported;
    el.mute.textContent = speech.muted ? 'Unmute' : 'Mute';
    el.mute.setAttribute('aria-pressed', speech.muted ? 'true' : 'false');

    var canTest = speech.supported && !state.announcing && !isCounting();
    el.test.disabled = !canTest;
    el.testHint.hidden = !(speech.supported && isCounting());
  }

  /* ---------- Voice settings ---------- */

  function loadSettings() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var s = JSON.parse(raw);
      if (typeof s.voiceURI === 'string') speech.voiceURI = s.voiceURI;
      if (typeof s.rate === 'number' && s.rate >= 0.6 && s.rate <= 1.4) speech.rate = s.rate;
      if (typeof s.volume === 'number' && s.volume >= 0 && s.volume <= 1) speech.volume = s.volume;
      if (typeof s.muted === 'boolean') speech.muted = s.muted;
    } catch (e) { /* storage unavailable: defaults are used */ }
  }

  function saveSettings() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        voiceURI: speech.voiceURI,
        rate: speech.rate,
        volume: speech.volume,
        muted: speech.muted
      }));
    } catch (e) { /* storage unavailable: settings last for this visit only */ }
  }

  function pickDefaultVoice(list) {
    var prefs = ['en-IN', 'en-GB', 'en-US'];
    for (var p = 0; p < prefs.length; p++) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].lang && list[i].lang.replace('_', '-').toLowerCase() === prefs[p].toLowerCase()) {
          return list[i];
        }
      }
    }
    return list[0] || null;
  }

  function populateVoices() {
    var all = window.speechSynthesis.getVoices() || [];
    speech.voices = all;
    var english = all.filter(function (v) { return /^en([-_]|$)/i.test(v.lang || ''); });
    var list = english.length ? english : all;

    if (speech.voiceURI && !list.some(function (v) { return v.voiceURI === speech.voiceURI; })) {
      speech.voiceURI = '';
    }
    if (!speech.voiceURI && list.length) {
      var def = pickDefaultVoice(list);
      if (def) speech.voiceURI = def.voiceURI;
    }

    el.voiceSelect.textContent = '';
    var defOpt = document.createElement('option');
    defOpt.value = '';
    defOpt.textContent = 'Browser default';
    el.voiceSelect.appendChild(defOpt);
    list.forEach(function (v) {
      var opt = document.createElement('option');
      opt.value = v.voiceURI;
      opt.textContent = v.name + ' (' + v.lang + ')' + (v.localService ? '' : ', online');
      el.voiceSelect.appendChild(opt);
    });
    el.voiceSelect.value = speech.voiceURI;

    if (all.length > 0 && el.warning.dataset.kind === 'no-voices') {
      el.warning.hidden = true;
      el.warning.dataset.kind = '';
    }
  }

  function showWarning(kind, text) {
    el.warning.dataset.kind = kind;
    el.warning.textContent = text;
    el.warning.hidden = false;
  }

  function setupSpeech() {
    el.rate.value = String(speech.rate);
    el.volume.value = String(speech.volume);
    el.rateOut.textContent = speech.rate.toFixed(1) + 'x';
    el.volumeOut.textContent = Math.round(speech.volume * 100) + '%';

    if (!speech.supported) {
      showWarning('unsupported',
        'This browser cannot speak the numbers. The game still works and every number is shown on screen. ' +
        'For voice announcements, open this page in a current version of Google Chrome or Microsoft Edge.');
      el.voiceSelect.disabled = true;
      el.rate.disabled = true;
      el.volume.disabled = true;
      return;
    }

    window.speechSynthesis.cancel(); // clear anything left over from a previous page load
    populateVoices();
    if (typeof window.speechSynthesis.addEventListener === 'function') {
      window.speechSynthesis.addEventListener('voiceschanged', populateVoices);
    } else {
      window.speechSynthesis.onvoiceschanged = populateVoices;
    }

    setTimeout(function () {
      if (speech.voices.length === 0) {
        showWarning('no-voices',
          'No speech voices were found on this device, so announcements may be silent. ' +
          'Press Test Voice to check. Numbers are always shown on screen.');
      }
    }, 2000);

    el.voiceSelect.addEventListener('change', function () {
      speech.voiceURI = el.voiceSelect.value;
      saveSettings();
    });
    el.rate.addEventListener('input', function () {
      var v = parseFloat(el.rate.value);
      if (!isNaN(v)) speech.rate = v;
      el.rateOut.textContent = speech.rate.toFixed(1) + 'x';
      saveSettings();
    });
    el.volume.addEventListener('input', function () {
      var v = parseFloat(el.volume.value);
      if (!isNaN(v)) speech.volume = v;
      el.volumeOut.textContent = Math.round(speech.volume * 100) + '%';
      saveSettings();
    });
  }

  /* ---------- Reset confirmation ---------- */

  function openResetDialog() {
    if (el.reset.disabled) return;
    if (typeof el.dialog.showModal === 'function') {
      if (!el.dialog.open) el.dialog.showModal();
      el.resetCancel.focus();
    } else {
      el.dialog.setAttribute('open', '');
    }
  }

  function closeResetDialog() {
    if (typeof el.dialog.close === 'function') {
      if (el.dialog.open) el.dialog.close();
    } else {
      el.dialog.removeAttribute('open');
    }
  }

  /* ---------- Wiring ---------- */

  function init() {
    buildBoard();
    loadSettings();
    setupSpeech();

    el.start.addEventListener('click', startGame);
    el.pause.addEventListener('click', pauseGame);
    el.resume.addEventListener('click', resumeGame);
    el.next.addEventListener('click', callNext);
    el.repeat.addEventListener('click', repeatLast);
    el.mute.addEventListener('click', toggleMute);
    el.test.addEventListener('click', testVoice);
    el.reset.addEventListener('click', openResetDialog);
    el.resetCancel.addEventListener('click', closeResetDialog);
    el.resetConfirm.addEventListener('click', function () {
      closeResetDialog();
      resetGame();
    });

    // Clean up the timer and any speech when the page is closed or hidden for good.
    window.addEventListener('pagehide', function () {
      if (isCounting()) pauseGame();
      stopTimer();
      if (speech.supported) window.speechSynthesis.cancel();
    });

    render();
  }

  init();
})();
