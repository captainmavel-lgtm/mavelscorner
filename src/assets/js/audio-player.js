/**
 * MAVEL'S CORNER — READ ALOUD PLAYER
 * File: src/assets/js/audio-player.js
 * v3.0 — Draggable progress, gender toggle, volume,
 *         progress memory, keyboard shortcuts, Android keep-alive
 */

(function () {
  'use strict';

  const postContent = document.querySelector('.article-inner, article.article-body, main article');
  if (!postContent) return;

  const synth = window.speechSynthesis;
  if (!synth) {
    var t = document.getElementById('mc-audio-trigger');
    if (t) t.style.display = 'none';
    return;
  }

  /* ── DOM REFERENCES ── */
  const trigger        = document.getElementById('mc-audio-trigger');
  const player         = document.getElementById('mc-audio-player');
  const btnPlay        = document.getElementById('ap-btn-play');
  const btnStop        = document.getElementById('ap-btn-stop');
  const btnClose       = document.getElementById('ap-close');
  const wave           = document.getElementById('ap-wave');
  const progressTrack  = document.getElementById('ap-progress-track');
  const progressFill   = document.getElementById('ap-progress-fill');
  const progressThumb  = document.getElementById('ap-progress-thumb');
  const timeElapsed    = document.getElementById('ap-time-elapsed');
  const timeDuration   = document.getElementById('ap-time-duration');
  const statusEl       = document.getElementById('ap-status');
  const voiceSelect    = document.getElementById('ap-voice-select');
  const fabLabel       = document.getElementById('ap-fab-label');
  const speedBtns      = document.querySelectorAll('.ap-speed-btn');
  const genderBtns     = document.querySelectorAll('.ap-gender-btn');
  const volumeSlider   = document.getElementById('ap-volume-slider');
  const volumePct      = document.getElementById('ap-volume-pct');
  const resumePrompt   = document.getElementById('ap-resume-prompt');
  const resumeText     = document.getElementById('ap-resume-text');
  const resumeYes      = document.getElementById('ap-resume-yes');
  const resumeNo       = document.getElementById('ap-resume-no');
  const silentAudio    = document.getElementById('ap-silent-audio');

  if (!trigger || !player || !btnPlay) return;

  /* ── STATE ── */
  let utterances           = [];
  let currentIdx           = 0;
  let isPlaying            = false;
  let isPaused             = false;
  let totalChunks          = 0;
  let voices               = [];
  let selectedVoice        = null;
  let currentGender        = 'female';
  let currentRate          = 1.0;
  let currentVolume        = 1.0;
  let startTime            = null;
  let elapsedSecs          = 0;
  let timerInterval        = null;
  let estimatedDuration    = 0;
  let wasPlayingBeforeHidden = false;
  let isDragging           = false;
  let dragTargetIdx        = 0;

  /* ── STORAGE KEY ── */
  const STORAGE_KEY  = 'mc_audio_progress_' + window.location.pathname;
  const VOLUME_KEY   = 'mc_audio_volume';

  /* ── RESTORE PERSISTED VOLUME ── */
  (function () {
    var saved = localStorage.getItem(VOLUME_KEY);
    if (saved !== null) {
      currentVolume = Math.min(1, Math.max(0, parseFloat(saved) || 1));
      if (volumeSlider) volumeSlider.value = Math.round(currentVolume * 100);
      updateVolumeUI();
    }
  })();

  /* ============================================================
     CONTENT EXTRACTION
  ============================================================ */
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
      return skipSelectors.some(function (sel) { return el.closest(sel); });
    }

    function isHashtagLine(text) {
      return /^(#[A-Za-z]+\s*){3,}/.test(text.trim());
    }

    const walker = document.createTreeWalker(postContent, NodeFilter.SHOW_ELEMENT, null, false);
    let node = walker.currentNode;

    while (node) {
      const tag = node.nodeName.toLowerCase();
      if (shouldSkip(node)) { node = walker.nextNode(); continue; }

      if (['h2', 'h3', 'h4'].includes(tag)) {
        const text = node.innerText.trim();
        if (text && !isHashtagLine(text)) { parts.push(''); parts.push(text + '.'); parts.push(''); }
      } else if (tag === 'p') {
        const text = node.innerText.trim();
        if (text && !isHashtagLine(text)) {
          parts.push(text
            .replace(/[\u2018\u2019]/g, "'")
            .replace(/[\u201C\u201D]/g, '"')
            .replace(/[\u2013\u2014]/g, ', ')
            .replace(/\s+/g, ' '));
        }
      } else if (tag === 'blockquote') {
        const text = node.innerText.trim();
        if (text && !isHashtagLine(text)) {
          parts.push('Scripture: ' + text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"'));
        }
      } else if (tag === 'li') {
        const text = node.innerText.trim();
        if (text && !isHashtagLine(text)) parts.push(text + '.');
      }
      node = walker.nextNode();
    }

    parts.push('');
    parts.push("That is the end of this post. Thank you for reading along with Mavel's Corner. God bless you.");
    return parts.filter(function (p) { return p !== undefined; });
  }

  /* ============================================================
     CHUNKING + UTTERANCE BUILDING
  ============================================================ */
  function chunkText(text, maxLen) {
    maxLen = maxLen || 180;
    if (text.length <= maxLen) return [text];
    const chunks = [];
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    let current = '';
    sentences.forEach(function (s) {
      if ((current + s).length > maxLen && current.length > 0) { chunks.push(current.trim()); current = s; }
      else current += s;
    });
    if (current.trim()) chunks.push(current.trim());
    return chunks;
  }

  function buildUtterances(script, rate, voice, volume) {
    const all = [];
    script.forEach(function (part) {
      if (!part.trim()) {
        const pause = new SpeechSynthesisUtterance(' ');
        pause.volume = 0; pause.rate = rate;
        all.push(pause); return;
      }
      chunkText(part).forEach(function (chunk) {
        const u = new SpeechSynthesisUtterance(chunk);
        u.rate   = rate;
        u.pitch  = 1.0;
        u.volume = volume;
        if (voice) u.voice = voice;
        all.push(u);
      });
    });
    return all;
  }

  /* ============================================================
     DURATION + FORMATTING
  ============================================================ */
  function estimateDuration(script, rate) {
    const wc = script.join(' ').trim().split(/\s+/).length;
    return Math.round((wc / (150 * rate)) * 60);
  }

  function formatTime(secs) {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* ============================================================
     VOICES
  ============================================================ */
  const FEMALE_KEYS = ['female','woman','zira','samantha','victoria','fiona','karen','moira','veena','tessa','serena','alice','allison','ava','joanna','aria','jenny','sonia','libby'];
  const MALE_KEYS   = ['male','man','david','mark','richard','daniel','james','george','fred','alex','tom','eric','guy','ivan','oliver','ryan'];

  function loadVoices() {
    voices = synth.getVoices();
    if (!voices.length) return;
    populateVoiceSelect();
    applyGender(currentGender, false);
  }

  function populateVoiceSelect() {
    if (!voiceSelect) return;
    voiceSelect.innerHTML = '';
    const en   = voices.filter(function (v) { return v.lang.startsWith('en'); });
    const list = en.length ? en : voices;
    list.forEach(function (v) {
      const opt       = document.createElement('option');
      opt.textContent = v.name.replace('Google ','').replace('Microsoft ','').substring(0, 26);
      opt.dataset.idx = voices.indexOf(v);
      voiceSelect.appendChild(opt);
    });
  }

  function applyGender(gender, rebuildIfActive) {
    currentGender = gender;
    const keys  = gender === 'female' ? FEMALE_KEYS : MALE_KEYS;
    const en    = voices.filter(function (v) { return v.lang.startsWith('en'); });
    const pool  = en.length ? en : voices;

    let best = pool.find(function (v) {
      return keys.some(function (k) { return v.name.toLowerCase().includes(k); });
    });
    if (!best) best = pool.find(function (v) { return v.lang === 'en-US' || v.lang === 'en-GB'; });
    if (!best) best = pool[0];
    selectedVoice = best || null;

    /* Sync dropdown to chosen voice */
    if (voiceSelect && best) {
      const ti = voices.indexOf(best);
      Array.from(voiceSelect.options).forEach(function (opt) {
        if (parseInt(opt.dataset.idx) === ti) opt.selected = true;
      });
    }

    /* Update gender button states */
    genderBtns.forEach(function (btn) {
      const active = btn.dataset.gender === gender;
      btn.classList.toggle('ap-active', active);
      btn.setAttribute('aria-pressed', String(active));
    });

    if (rebuildIfActive && (isPlaying || isPaused)) {
      var savedIdx = currentIdx;
      var savedEl  = elapsedSecs;
      isPlaying = false; isPaused = false;
      stopTimer(); startTime = null; elapsedSecs = savedEl;
      buildAndPlayFrom(savedIdx);
    }
  }

  synth.onvoiceschanged = loadVoices;
  loadVoices();

  /* ============================================================
     PLAYBACK ENGINE
  ============================================================ */
  function buildAndPlay() {
    synth.cancel();
    const script      = extractReadingScript();
    estimatedDuration = estimateDuration(script, currentRate);
    if (timeDuration) timeDuration.textContent = formatTime(estimatedDuration);
    utterances  = buildUtterances(script, currentRate, selectedVoice, currentVolume);
    totalChunks = utterances.length;
    currentIdx  = 0;
    speakFrom(0);
  }

  function buildAndPlayFrom(idx) {
    synth.cancel();
    const script      = extractReadingScript();
    estimatedDuration = estimateDuration(script, currentRate);
    if (timeDuration) timeDuration.textContent = formatTime(estimatedDuration);
    utterances  = buildUtterances(script, currentRate, selectedVoice, currentVolume);
    totalChunks = utterances.length;
    currentIdx  = (idx < totalChunks) ? idx : 0;
    speakFrom(currentIdx);
  }

  function speakFrom(idx) {
    if (idx >= utterances.length) { onPlaybackEnd(); return; }
    const u = utterances[idx];

    u.onstart = function () {
      isPlaying = true;
      isPaused  = false;
      updatePlayUI(true);
      if (!timerInterval) {
        if (!startTime) startTime = Date.now() - (elapsedSecs * 1000);
        startTimer();
      }
      if (idx === 0 || !silentAudio || silentAudio.paused) startSilentAudio();
    };

    u.onend = function () {
      currentIdx = idx + 1;
      saveProgress();
      updateProgress();
      speakFrom(currentIdx);
    };

    u.onerror = function (e) {
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      currentIdx = idx + 1;
      speakFrom(currentIdx);
    };

    synth.speak(u);
    setStatus('Reading aloud...', true);
  }

  function onPlaybackEnd() {
    isPlaying = false; isPaused = false; startTime = null;
    stopTimer(); stopSilentAudio(); clearProgress();
    updatePlayUI(false); updateProgress(1);
    setStatus('Finished. Play again to restart.');
    if (timeElapsed) timeElapsed.textContent = formatTime(estimatedDuration);
    if (fabLabel) fabLabel.textContent = 'Listen Again';
  }

  /* ============================================================
     PLAY / PAUSE / STOP
  ============================================================ */
  function togglePlay() {
    if (!isPlaying && !isPaused) {
      elapsedSecs = 0; startTime = null;
      buildAndPlay();
    } else if (isPlaying && !isPaused) {
      synth.cancel();
      isPaused = true; isPlaying = false;
      updatePlayUI(false); stopTimer(); stopSilentAudio();
      setStatus('Paused.');
    } else if (isPaused) {
      isPaused  = false; isPlaying = false;
      startTime = Date.now() - (elapsedSecs * 1000);
      speakFrom(currentIdx);
    }
  }

  function stopPlayback() {
    synth.cancel();
    isPlaying = false; isPaused = false;
    startTime = null; elapsedSecs = 0; currentIdx = 0;
    stopTimer(); stopSilentAudio(); clearProgress();
    updatePlayUI(false); updateProgress(0);
    if (timeElapsed) timeElapsed.textContent = '0:00';
    setStatus('Stopped.');
    if (fabLabel) fabLabel.textContent = 'Listen';
  }

  /* ============================================================
     PROGRESS BAR — DRAGGABLE SCRUBBER
  ============================================================ */
  function pctToIdx(pct) {
    if (!totalChunks) return 0;
    return Math.min(totalChunks - 1, Math.max(0, Math.round(pct * totalChunks)));
  }

  function getTrackPct(clientX) {
    if (!progressTrack) return 0;
    const rect = progressTrack.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }

  function setProgressVisual(pct) {
    if (progressFill)  progressFill.style.width = (pct * 100) + '%';
    if (progressThumb) progressThumb.style.left  = (pct * 100) + '%';
    if (progressTrack) progressTrack.setAttribute('aria-valuenow', Math.round(pct * 100));
  }

  function seekTo(pct) {
    const targetIdx = pctToIdx(pct);
    const wasActive = isPlaying || isPaused;
    const savedEl   = elapsedSecs;

    /* Update elapsed estimate proportionally */
    elapsedSecs = pct * estimatedDuration;
    startTime   = wasActive ? Date.now() - (elapsedSecs * 1000) : null;

    isPlaying = false; isPaused = false;
    stopTimer(); synth.cancel();

    currentIdx = targetIdx;
    setProgressVisual(pct);

    if (wasActive) {
      buildAndPlayFrom(targetIdx);
    } else {
      /* Stopped — just update visual, ready to play from new position */
      utterances  = buildUtterances(extractReadingScript(), currentRate, selectedVoice, currentVolume);
      totalChunks = utterances.length;
      setStatus('Ready. Tap play to continue.');
    }
  }

  /* Disable smooth transition during drag, re-enable after */
  function startDrag() {
    isDragging = true;
    if (progressFill) progressFill.classList.remove('ap-smooth');
    if (progressTrack) progressTrack.classList.add('ap-dragging');
  }

  function endDrag(finalPct) {
    isDragging = false;
    if (progressFill) progressFill.classList.add('ap-smooth');
    if (progressTrack) progressTrack.classList.remove('ap-dragging');
    seekTo(finalPct);
  }

  /* Mouse events */
  if (progressTrack) {
    progressTrack.addEventListener('mousedown', function (e) {
      e.preventDefault();
      startDrag();
      var pct = getTrackPct(e.clientX);
      setProgressVisual(pct);

      function onMove(e2) {
        pct = getTrackPct(e2.clientX);
        setProgressVisual(pct);
      }
      function onUp(e2) {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
        endDrag(getTrackPct(e2.clientX));
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });

    /* Touch events */
    progressTrack.addEventListener('touchstart', function (e) {
      e.preventDefault();
      startDrag();
      var pct = getTrackPct(e.touches[0].clientX);
      setProgressVisual(pct);

      function onMove(e2) {
        pct = getTrackPct(e2.touches[0].clientX);
        setProgressVisual(pct);
      }
      function onEnd(e2) {
        progressTrack.removeEventListener('touchmove', onMove);
        progressTrack.removeEventListener('touchend',  onEnd);
        endDrag(pct);
      }
      progressTrack.addEventListener('touchmove', onMove, { passive: false });
      progressTrack.addEventListener('touchend',  onEnd);
    }, { passive: false });

    /* Keyboard arrow seek on the track element */
    progressTrack.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        var step = 1 / Math.max(totalChunks, 1);
        var cur  = totalChunks > 0 ? currentIdx / totalChunks : 0;
        var next = e.key === 'ArrowRight' ? cur + step * 5 : cur - step * 5;
        seekTo(Math.min(1, Math.max(0, next)));
      }
    });
  }

  /* ============================================================
     UI HELPERS
  ============================================================ */
  function updatePlayUI(playing) {
    if (btnPlay) {
      btnPlay.innerHTML = playing
        ? '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
        : '<svg viewBox="0 0 24 24"><polygon points="5,3 19,12 5,21"/></svg>';
      btnPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    }
    if (wave)    wave.classList.toggle('ap-wave-active', playing);
    if (trigger) trigger.classList.toggle('ap-playing', playing);
  }

  function updateProgress(force) {
    if (isDragging) return; /* don't fight the drag */
    const pct = (force !== undefined) ? force : (totalChunks > 0 ? currentIdx / totalChunks : 0);
    setProgressVisual(Math.min(pct, 1));
  }

  function setStatus(msg, active) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.classList.toggle('ap-status-active', !!active);
  }

  function startTimer() {
    stopTimer();
    timerInterval = setInterval(function () {
      if (!startTime) return;
      elapsedSecs = (Date.now() - startTime) / 1000;
      if (timeElapsed) timeElapsed.textContent = formatTime(elapsedSecs);
      updateProgress();
    }, 500);
  }

  function stopTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }

  /* ============================================================
     VOLUME
  ============================================================ */
  function updateVolumeUI() {
    if (!volumeSlider) return;
    const pct = Math.round(currentVolume * 100);
    if (volumePct) volumePct.textContent = pct + '%';
    /* Teal fill gradient on the track */
    volumeSlider.style.background =
      'linear-gradient(to right, var(--ap-teal) 0%, var(--ap-teal) ' + pct + '%, rgba(255,255,255,0.10) ' + pct + '%, rgba(255,255,255,0.10) 100%)';
  }

  if (volumeSlider) {
    volumeSlider.addEventListener('input', function () {
      currentVolume = parseInt(volumeSlider.value) / 100;
      localStorage.setItem(VOLUME_KEY, currentVolume);
      updateVolumeUI();
      /* Apply immediately to active speech by rebuilding from current idx */
      if (isPlaying || isPaused) {
        var savedIdx = currentIdx;
        var savedEl  = elapsedSecs;
        isPlaying = false; isPaused = false;
        stopTimer(); synth.cancel(); elapsedSecs = savedEl; startTime = null;
        buildAndPlayFrom(savedIdx);
      }
    });
  }

  updateVolumeUI();

  /* ============================================================
     PROGRESS MEMORY (localStorage per post)
  ============================================================ */
  function saveProgress() {
    if (!totalChunks || currentIdx <= 0) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        idx:     currentIdx,
        elapsed: elapsedSecs,
        total:   totalChunks
      }));
    } catch (e) {}
  }

  function loadProgress() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (data && data.idx > 0 && data.total > 0) return data;
    } catch (e) {}
    return null;
  }

  function clearProgress() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }

  function showResumePrompt(data) {
    if (!resumePrompt) return;
    var pct = Math.round((data.idx / data.total) * 100);
    if (resumeText) resumeText.textContent = 'Resume from ' + pct + '% through this post?';
    resumePrompt.classList.add('ap-visible');
  }

  function hideResumePrompt() {
    if (resumePrompt) resumePrompt.classList.remove('ap-visible');
  }

  if (resumeYes) {
    resumeYes.addEventListener('click', function () {
      hideResumePrompt();
      var data = loadProgress();
      if (!data) { buildAndPlay(); return; }
      elapsedSecs = data.elapsed || 0;
      startTime   = null;
      buildAndPlayFrom(data.idx);
    });
  }

  if (resumeNo) {
    resumeNo.addEventListener('click', function () {
      hideResumePrompt();
      clearProgress();
      elapsedSecs = 0; startTime = null;
      buildAndPlay();
    });
  }

  /* ============================================================
     SILENT KEEP-ALIVE (Android screen lock)
  ============================================================ */
  function startSilentAudio() {
    if (!silentAudio) return;
    if (!silentAudio.src || silentAudio.src === window.location.href) {
      silentAudio.src = buildSilentWav();
    }
    silentAudio.volume = 0.001; /* near-zero but non-zero — OS registers as active media session */
    silentAudio.loop   = true;
    silentAudio.play().catch(function () {});
  }

  function stopSilentAudio() {
    if (!silentAudio) return;
    silentAudio.pause();
    silentAudio.currentTime = 0;
  }

  function buildSilentWav() {
    const numSamples = 8000;
    const buffer = new ArrayBuffer(44 + numSamples);
    const view   = new DataView(buffer);
    function writeStr(o, s) { for (var i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); }
    writeStr(0,  'RIFF');
    view.setUint32(4,  36 + numSamples, true);
    writeStr(8,  'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1,  true);
    view.setUint16(22, 1,  true);
    view.setUint32(24, 8000, true);
    view.setUint32(28, 8000, true);
    view.setUint16(32, 1,  true);
    view.setUint16(34, 8,  true);
    writeStr(36, 'data');
    view.setUint32(40, numSamples, true);
    const bytes = new Uint8Array(buffer);
    let bin = '';
    bytes.forEach(function (b) { bin += String.fromCharCode(b); });
    return 'data:audio/wav;base64,' + btoa(bin);
  }

  /* ============================================================
     PAGE VISIBILITY (screen lock auto-resume)
  ============================================================ */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      if (isPlaying && !isPaused) {
        wasPlayingBeforeHidden = true;
        synth.cancel();
        isPaused = true; isPlaying = false;
        stopTimer(); stopSilentAudio();
      } else {
        wasPlayingBeforeHidden = false;
      }
    } else if (document.visibilityState === 'visible') {
      if (wasPlayingBeforeHidden) {
        wasPlayingBeforeHidden = false;
        setTimeout(function () {
          if (isPaused && !isPlaying) {
            isPaused  = false;
            startTime = Date.now() - (elapsedSecs * 1000);
            setStatus('Resuming...', true);
            speakFrom(currentIdx);
          }
        }, 400);
      }
    }
  });

  /* ============================================================
     KEYBOARD SHORTCUTS
  ============================================================ */
  document.addEventListener('keydown', function (e) {
    /* Only fire when player is open and no input is focused */
    if (!player.classList.contains('ap-open')) return;
    const tag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
    if (['input','textarea','select'].includes(tag)) return;
    /* Don't intercept if focus is on progress track (it handles its own arrows) */
    if (document.activeElement === progressTrack) return;

    switch (e.key) {
      case ' ':
      case 'Spacebar':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowRight':
        e.preventDefault();
        skipChunks(+skipAmount());
        break;
      case 'ArrowLeft':
        e.preventDefault();
        skipChunks(-skipAmount());
        break;
      case 'Escape':
        closePlayer();
        break;
    }
  });

  /* Approximate chunks equivalent to ~10 seconds */
  function skipAmount() {
    if (!totalChunks || !estimatedDuration) return 5;
    return Math.max(1, Math.round((10 / estimatedDuration) * totalChunks));
  }

  function skipChunks(delta) {
    if (!totalChunks) return;
    var target = Math.min(totalChunks - 1, Math.max(0, currentIdx + delta));
    var pct    = target / totalChunks;
    elapsedSecs = pct * estimatedDuration;
    startTime   = (isPlaying || isPaused) ? Date.now() - (elapsedSecs * 1000) : null;
    isPlaying = false; isPaused = false;
    stopTimer(); synth.cancel();
    currentIdx = target;
    setProgressVisual(pct);
    buildAndPlayFrom(target);
  }

  /* ============================================================
     PLAYER OPEN / CLOSE
  ============================================================ */
  function openPlayer() {
    player.classList.add('ap-open');
    trigger.setAttribute('aria-expanded', 'true');

    const titleEl = document.getElementById('ap-post-title');
    if (titleEl) {
      const h1 = document.querySelector('h1');
      titleEl.textContent = h1 ? h1.innerText.trim() : document.title;
    }

    const script  = extractReadingScript();
    estimatedDuration = estimateDuration(script, currentRate);
    if (timeDuration) timeDuration.textContent = formatTime(estimatedDuration);

    /* Pre-build utterances so totalChunks is available for resume prompt */
    utterances  = buildUtterances(script, currentRate, selectedVoice, currentVolume);
    totalChunks = utterances.length;

    /* Check for saved progress */
    hideResumePrompt();
    var saved = loadProgress();
    if (saved && saved.idx > 0 && saved.total > 0) {
      /* Sync totalChunks from save if close */
      showResumePrompt(saved);
    }
  }

  function closePlayer() {
    player.classList.remove('ap-open');
    trigger.setAttribute('aria-expanded', 'false');
    hideResumePrompt();
  }

  /* ============================================================
     EVENT LISTENERS
  ============================================================ */
  trigger.addEventListener('click', function () {
    player.classList.contains('ap-open') ? closePlayer() : openPlayer();
  });

  if (btnClose) btnClose.addEventListener('click', closePlayer);
  if (btnPlay)  btnPlay.addEventListener('click', togglePlay);
  if (btnStop)  btnStop.addEventListener('click', stopPlayback);

  /* Speed buttons */
  speedBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var rate = parseFloat(btn.dataset.rate);
      if (isNaN(rate)) return;
      currentRate = rate;
      speedBtns.forEach(function (b) { b.classList.remove('ap-active'); });
      btn.classList.add('ap-active');
      if (isPlaying || isPaused) {
        var savedIdx = currentIdx;
        var savedEl  = elapsedSecs;
        isPlaying = false; isPaused = false;
        stopTimer(); elapsedSecs = savedEl; startTime = null;
        buildAndPlayFrom(savedIdx);
      }
    });
  });

  /* Gender toggle */
  genderBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      applyGender(btn.dataset.gender, true);
    });
  });

  /* Voice dropdown (secondary) */
  if (voiceSelect) {
    voiceSelect.addEventListener('change', function () {
      var idx   = parseInt(voiceSelect.options[voiceSelect.selectedIndex].dataset.idx);
      var voice = voices[idx] || null;
      selectedVoice = voice;

      /* Reflect gender toggle based on chosen voice name */
      if (voice) {
        var name = voice.name.toLowerCase();
        var isFemale = FEMALE_KEYS.some(function (k) { return name.includes(k); });
        var isMale   = MALE_KEYS.some(function (k) { return name.includes(k); });
        if (isFemale)      currentGender = 'female';
        else if (isMale)   currentGender = 'male';
        genderBtns.forEach(function (b) {
          var active = b.dataset.gender === currentGender;
          b.classList.toggle('ap-active', active);
          b.setAttribute('aria-pressed', String(active));
        });
      }

      if (isPlaying || isPaused) {
        var savedIdx = currentIdx;
        isPlaying = false; isPaused = false;
        stopTimer(); startTime = null;
        buildAndPlayFrom(savedIdx);
      }
    });
  }

  /* ============================================================
     INITIAL STATE
  ============================================================ */
  updatePlayUI(false);
  updateProgress(0);
  setStatus('Tap play to listen to this post.');

  window.addEventListener('beforeunload', function () { synth.cancel(); });

})();
