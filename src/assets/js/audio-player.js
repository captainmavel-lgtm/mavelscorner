/**
 * MAVEL'S CORNER — READ ALOUD PLAYER
 * File: src/assets/js/audio-player.js
 */

(function () {
  'use strict';

  const postContent = document.querySelector('.article-inner, article.article-body, main article');
  if (!postContent) return;

  const synth = window.speechSynthesis;
  if (!synth) {
    const trigger = document.getElementById('mc-audio-trigger');
    if (trigger) trigger.style.display = 'none';
    return;
  }

  /* ── DOM REFERENCES ── */
  const trigger      = document.getElementById('mc-audio-trigger');
  const player       = document.getElementById('mc-audio-player');
  const btnPlay      = document.getElementById('ap-btn-play');
  const btnStop      = document.getElementById('ap-btn-stop');
  const btnClose     = document.getElementById('ap-close');
  const wave         = document.getElementById('ap-wave');
  const progressFill = document.getElementById('ap-progress-fill');
  const timeElapsed  = document.getElementById('ap-time-elapsed');
  const timeDuration = document.getElementById('ap-time-duration');
  const statusEl     = document.getElementById('ap-status');
  const voiceSelect  = document.getElementById('ap-voice-select');
  const fabLabel     = document.getElementById('ap-fab-label');
  const speedBtns    = document.querySelectorAll('.ap-speed-btn');

  if (!trigger || !player || !btnPlay) return;

  /* ── STATE ── */
  let utterances        = [];
  let currentIdx        = 0;
  let isPlaying         = false;
  let isPaused          = false;
  let totalChunks       = 0;
  let voices            = [];
  let selectedVoice     = null;
  let currentRate       = 1.0;
  let startTime         = null;
  let elapsedSecs       = 0;
  let timerInterval     = null;
  let estimatedDuration = 0;

  /* ── CONTENT EXTRACTION ── */
  function extractReadingScript() {
    const parts = [];

    const h1 = document.querySelector('h1');
    if (h1) parts.push(h1.innerText.trim());

    const dateEl = document.querySelector('.post-date, time, [class*="date"]');
    let byline = "Written by Emmanuel, on Mavel's Corner.";
    if (dateEl) byline += ' ' + dateEl.innerText.trim() + '.';
    parts.push(byline);
    parts.push('');

    const skipSelectors = [
      'nav', 'footer', '.tags', '.hashtags',
      '.share-buttons', '.share-row', '[class*="share"]',
      '[class*="prayer-form"]', '.post-footer',
      'script', 'style', 'noscript'
    ];

    function shouldSkip(el) {
      return skipSelectors.some(function(sel) { return el.closest(sel); });
    }

    function isHashtagLine(text) {
      return /^(#[A-Za-z]+\s*){3,}/.test(text.trim());
    }

    const walker = document.createTreeWalker(postContent, NodeFilter.SHOW_ELEMENT, null, false);
    let node = walker.currentNode;

    while (node) {
      const tag = node.nodeName.toLowerCase();
      if (shouldSkip(node)) { node = walker.nextNode(); continue; }

      if (['h2','h3','h4'].includes(tag)) {
        const text = node.innerText.trim();
        if (text && !isHashtagLine(text)) {
          parts.push('');
          parts.push(text + '.');
          parts.push('');
        }
      } else if (tag === 'p') {
        const text = node.innerText.trim();
        if (text && !isHashtagLine(text)) {
          parts.push(
            text.replace(/[\u2018\u2019]/g, "'")
                .replace(/[\u201C\u201D]/g, '"')
                .replace(/[\u2013\u2014]/g, ', ')
                .replace(/\s+/g, ' ')
          );
        }
      } else if (tag === 'blockquote') {
        const text = node.innerText.trim();
        if (text && !isHashtagLine(text)) {
          parts.push('Scripture: ' + text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"'));
        }
      } else if (tag === 'li') {
        const text = node.innerText.trim();
        if (text && !isHashtagLine(text)) {
          parts.push(text + '.');
        }
      }

      node = walker.nextNode();
    }

    parts.push('');
    parts.push("That is the end of this post. Thank you for reading along with Mavel's Corner. God bless you.");
    return parts.filter(function(p) { return p !== undefined; });
  }

  /* ── CHUNK TEXT ── */
  function chunkText(text, maxLen) {
    maxLen = maxLen || 180;
    if (text.length <= maxLen) return [text];
    const chunks = [];
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    let current = '';
    sentences.forEach(function(s) {
      if ((current + s).length > maxLen && current.length > 0) {
        chunks.push(current.trim());
        current = s;
      } else {
        current += s;
      }
    });
    if (current.trim()) chunks.push(current.trim());
    return chunks;
  }

  function buildUtterances(script, rate, voice) {
    const all = [];
    script.forEach(function(part) {
      if (!part.trim()) {
        const pause = new SpeechSynthesisUtterance(' ');
        pause.volume = 0;
        pause.rate = rate;
        all.push(pause);
        return;
      }
      chunkText(part).forEach(function(chunk) {
        const u = new SpeechSynthesisUtterance(chunk);
        u.rate   = rate;
        u.pitch  = 1.0;
        u.volume = 1.0;
        if (voice) u.voice = voice;
        all.push(u);
      });
    });
    return all;
  }

  /* ── DURATION ── */
  function estimateDuration(script, rate) {
    const wc = script.join(' ').trim().split(/\s+/).length;
    return Math.round((wc / (150 * rate)) * 60);
  }

  function formatTime(secs) {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* ── VOICES ── */
  function loadVoices() {
    voices = synth.getVoices();
    if (!voices.length) return;
    populateVoiceSelect();
    selectDefaultVoice();
  }

  function populateVoiceSelect() {
    if (!voiceSelect) return;
    voiceSelect.innerHTML = '';
    const en = voices.filter(function(v) { return v.lang.startsWith('en'); });
    const list = en.length ? en : voices;
    list.forEach(function(v) {
      const opt = document.createElement('option');
      opt.textContent = v.name.replace('Google ', '').replace('Microsoft ', '').substring(0, 22);
      opt.dataset.idx = voices.indexOf(v);
      voiceSelect.appendChild(opt);
    });
  }

  function selectDefaultVoice() {
    const fk = ['female','woman','zira','samantha','victoria','fiona','karen','moira',
                 'veena','tessa','serena','alice','allison','ava','joanna','aria','jenny','sonia','libby'];
    const en = voices.filter(function(v) { return v.lang.startsWith('en'); });
    const pool = en.length ? en : voices;
    let best = pool.find(function(v) { return fk.some(function(k) { return v.name.toLowerCase().includes(k); }); });
    if (!best) best = pool.find(function(v) { return v.lang === 'en-GB' || v.lang === 'en-US'; });
    if (!best) best = pool[0];
    selectedVoice = best || null;
    if (voiceSelect && best) {
      const ti = voices.indexOf(best);
      Array.from(voiceSelect.options).forEach(function(opt) {
        if (parseInt(opt.dataset.idx) === ti) opt.selected = true;
      });
    }
  }

  synth.onvoiceschanged = loadVoices;
  loadVoices();

  /* ── PLAYBACK ENGINE ── */
  function buildAndPlay() {
    synth.cancel();
    const script = extractReadingScript();
    estimatedDuration = estimateDuration(script, currentRate);
    if (timeDuration) timeDuration.textContent = formatTime(estimatedDuration);
    utterances  = buildUtterances(script, currentRate, selectedVoice);
    totalChunks = utterances.length;
    currentIdx  = 0;
    speakFrom(0);
  }

  function buildAndPlayFrom(idx) {
    /* Rebuild utterances (e.g. after speed change) and start from a saved index */
    synth.cancel();
    const script = extractReadingScript();
    estimatedDuration = estimateDuration(script, currentRate);
    if (timeDuration) timeDuration.textContent = formatTime(estimatedDuration);
    utterances  = buildUtterances(script, currentRate, selectedVoice);
    totalChunks = utterances.length;
    currentIdx  = (idx < totalChunks) ? idx : 0;
    speakFrom(currentIdx);
  }

  function speakFrom(idx) {
    if (idx >= utterances.length) { onPlaybackEnd(); return; }
    const u = utterances[idx];

    u.onstart = function() {
      isPlaying = true;
      isPaused  = false;
      updatePlayUI(true);
      /* Only start timer if not already running */
      if (!timerInterval) {
        if (!startTime) startTime = Date.now() - (elapsedSecs * 1000);
        startTimer();
      }
    };

    u.onend = function() {
      currentIdx = idx + 1;
      updateProgress();
      speakFrom(currentIdx);
    };

    u.onerror = function(e) {
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      currentIdx = idx + 1;
      speakFrom(currentIdx);
    };

    synth.speak(u);
    setStatus('Reading aloud...', true);
  }

  function onPlaybackEnd() {
    isPlaying = false;
    isPaused  = false;
    startTime = null;
    stopTimer();
    updatePlayUI(false);
    updateProgress(1);
    setStatus('Finished. Play again to restart.');
    if (timeElapsed) timeElapsed.textContent = formatTime(estimatedDuration);
    if (fabLabel) fabLabel.textContent = 'Listen Again';
  }

  /* ── TOGGLE PLAY / PAUSE ── */
  function togglePlay() {
    if (!isPlaying && !isPaused) {
      /* Fresh start */
      elapsedSecs = 0;
      startTime   = null;
      buildAndPlay();
    } else if (isPlaying && !isPaused) {
      /* Pause — cancel speech and save position */
      synth.cancel();
      isPaused  = true;
      isPlaying = false;
      updatePlayUI(false);
      stopTimer();
      setStatus('Paused.');
    } else if (isPaused) {
      /* Resume from exact saved chunk, timer continues from saved elapsed */
      isPaused  = false;
      isPlaying = false;
      startTime = Date.now() - (elapsedSecs * 1000);
      speakFrom(currentIdx);
    }
  }

  function stopPlayback() {
    synth.cancel();
    isPlaying   = false;
    isPaused    = false;
    startTime   = null;
    elapsedSecs = 0;
    currentIdx  = 0;
    stopTimer();
    updatePlayUI(false);
    updateProgress(0);
    if (timeElapsed) timeElapsed.textContent = '0:00';
    setStatus('Stopped.');
    if (fabLabel) fabLabel.textContent = 'Listen';
  }

  /* ── UI HELPERS ── */
  function updatePlayUI(playing) {
    if (btnPlay) {
      btnPlay.innerHTML = playing
        ? '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
        : '<svg viewBox="0 0 24 24"><polygon points="5,3 19,12 5,21"/></svg>';
      btnPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    }
    if (wave) wave.classList.toggle('ap-wave-active', playing);
    if (trigger) trigger.classList.toggle('ap-playing', playing);
  }

  function updateProgress(force) {
    if (!progressFill) return;
    const pct = (force !== undefined) ? force : (totalChunks > 0 ? currentIdx / totalChunks : 0);
    progressFill.style.width = (Math.min(pct, 1) * 100) + '%';
  }

  function setStatus(msg, active) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.classList.toggle('ap-status-active', !!active);
  }

  function startTimer() {
    stopTimer();
    timerInterval = setInterval(function() {
      if (!startTime) return;
      elapsedSecs = (Date.now() - startTime) / 1000;
      if (timeElapsed) timeElapsed.textContent = formatTime(elapsedSecs);
      updateProgress();
    }, 500);
  }

  function stopTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }

  /* ── PLAYER OPEN / CLOSE ── */
  function openPlayer() {
    player.classList.add('ap-open');
    trigger.setAttribute('aria-expanded', 'true');
    const titleEl = document.getElementById('ap-post-title');
    if (titleEl) {
      const h1 = document.querySelector('h1');
      titleEl.textContent = h1 ? h1.innerText.trim() : document.title;
    }
    const script = extractReadingScript();
    estimatedDuration = estimateDuration(script, currentRate);
    if (timeDuration) timeDuration.textContent = formatTime(estimatedDuration);
  }

  function closePlayer() {
    player.classList.remove('ap-open');
    trigger.setAttribute('aria-expanded', 'false');
  }

  /* ── EVENT LISTENERS ── */
  trigger.addEventListener('click', function() {
    player.classList.contains('ap-open') ? closePlayer() : openPlayer();
  });

  if (btnClose) btnClose.addEventListener('click', closePlayer);
  if (btnPlay)  btnPlay.addEventListener('click', togglePlay);
  if (btnStop)  btnStop.addEventListener('click', stopPlayback);

  /* Speed buttons — rebuild at new rate from current position */
  speedBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      const rate = parseFloat(btn.dataset.rate);
      if (isNaN(rate)) return;
      currentRate = rate;
      speedBtns.forEach(function(b) { b.classList.remove('ap-active'); });
      btn.classList.add('ap-active');

      if (isPlaying || isPaused) {
        var savedIdx     = currentIdx;
        var savedElapsed = elapsedSecs;
        isPlaying = false;
        isPaused  = false;
        stopTimer();
        elapsedSecs = savedElapsed;
        startTime   = null;
        buildAndPlayFrom(savedIdx);
      }
    });
  });

  /* Voice selector */
  if (voiceSelect) {
    voiceSelect.addEventListener('change', function() {
      const idx = parseInt(voiceSelect.options[voiceSelect.selectedIndex].dataset.idx);
      selectedVoice = voices[idx] || null;
      if (isPlaying || isPaused) {
        var savedIdx = currentIdx;
        isPlaying = false;
        isPaused  = false;
        stopTimer();
        startTime = null;
        buildAndPlayFrom(savedIdx);
      }
    });
  }

  /* Initial state */
  updatePlayUI(false);
  updateProgress(0);
  setStatus('Tap play to listen to this post.');

  window.addEventListener('beforeunload', function() { synth.cancel(); });

})();
