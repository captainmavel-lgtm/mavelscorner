/**
 * MAVEL'S CORNER — READ ALOUD PLAYER
 * File: src/assets/js/audio-player.js
 *
 * Uses the Web Speech API (SpeechSynthesis) — 100% free, zero subscriptions.
 * Extracts post content from the DOM, builds a clean reading script,
 * and drives the floating player UI injected by audio-player.njk.
 */

(function () {
  'use strict';

  /* ── Guard: only run on post pages ── */
  const postContent = document.querySelector('.article-inner, article.article-body, main article');
  if (!postContent) return;

  /* ── Guard: browser support ── */
  const synth = window.speechSynthesis;
  if (!synth) {
    const trigger = document.getElementById('mc-audio-trigger');
    if (trigger) trigger.style.display = 'none';
    return;
  }

  /* ══════════════════════════════════════════
     1. DOM REFERENCES
  ══════════════════════════════════════════ */
  const trigger     = document.getElementById('mc-audio-trigger');
  const player      = document.getElementById('mc-audio-player');
  const btnPlay     = document.getElementById('ap-btn-play');
  const btnStop     = document.getElementById('ap-btn-stop');
  const btnClose    = document.getElementById('ap-close');
  const wave        = document.getElementById('ap-wave');
  const progressFill= document.getElementById('ap-progress-fill');
  const timeElapsed = document.getElementById('ap-time-elapsed');
  const timeDuration= document.getElementById('ap-time-duration');
  const statusEl    = document.getElementById('ap-status');
  const voiceSelect = document.getElementById('ap-voice-select');
  const fabLabel    = document.getElementById('ap-fab-label');
  const speedBtns   = document.querySelectorAll('.ap-speed-btn');

  if (!trigger || !player || !btnPlay) return;

  /* ══════════════════════════════════════════
     2. STATE
  ══════════════════════════════════════════ */
  let utterances   = [];   // array of SpeechSynthesisUtterance
  let currentIdx   = 0;
  let isPlaying    = false;
  let isPaused     = false;
  let totalChunks  = 0;
  let voices       = [];
  let selectedVoice= null;
  let currentRate  = 1.0;
  let startTime    = null;
  let elapsedSecs  = 0;
  let timerInterval= null;
  let estimatedDuration = 0; // in seconds, calculated from word count

  /* ══════════════════════════════════════════
     3. CONTENT EXTRACTION
     Reads post h1, scripture, body sections.
     Strips hashtags, nav, footer, share buttons.
  ══════════════════════════════════════════ */
  function extractReadingScript() {
    const parts = [];

    /* Post title */
    const h1 = document.querySelector('h1');
    if (h1) parts.push(h1.innerText.trim());

    /* Author + date intro */
    const authorEl = document.querySelector('.post-author, [class*="author"], .byline');
    const dateEl   = document.querySelector('.post-date, time, [class*="date"]');
    let byline = 'Written by Emmanuel, on Mavel\'s Corner.';
    if (dateEl) byline += ' ' + dateEl.innerText.trim() + '.';
    parts.push(byline);

    /* Pause */
    parts.push('');

    /* Gather all meaningful text nodes in post body,
       skipping: hashtag blocks, share buttons, footer, nav, prayer-form */
    const skipSelectors = [
      'nav', 'footer', '.tags', '.hashtags',
      '.share-buttons', '.share-row', '[class*="share"]',
      '[class*="prayer-form"]', '.post-footer',
      'script', 'style', 'noscript'
    ];

    function shouldSkip(el) {
      return skipSelectors.some(sel => el.closest(sel));
    }

    function isHashtagLine(text) {
      return /^(#[A-Za-z]+\s*){3,}/.test(text.trim());
    }

    /* Walk the post content element */
    const walker = document.createTreeWalker(
      postContent,
      NodeFilter.SHOW_ELEMENT,
      null,
      false
    );

    let node = walker.currentNode;
    while (node) {
      const tag = node.nodeName.toLowerCase();
      if (shouldSkip(node)) { node = walker.nextNode(); continue; }

      if (['h2','h3','h4'].includes(tag)) {
        const text = node.innerText.trim();
        if (text && !isHashtagLine(text)) {
          parts.push(''); // breath pause
          parts.push(text + '.');
          parts.push('');
        }
      } else if (tag === 'p') {
        const text = node.innerText.trim();
        if (text && !isHashtagLine(text)) {
          /* Replace smart quotes / em-dashes for cleaner TTS */
          const cleaned = text
            .replace(/[\u2018\u2019]/g, "'")
            .replace(/[\u201C\u201D]/g, '"')
            .replace(/[\u2013\u2014]/g, ', ')
            .replace(/\s+/g, ' ');
          parts.push(cleaned);
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

    /* Closing sign-off */
    parts.push('');
    parts.push('That is the end of this post. Thank you for reading along with Mavel\'s Corner. God bless you.');

    return parts.filter(p => p !== undefined);
  }

  /* ══════════════════════════════════════════
     4. CHUNK TEXT FOR RELIABLE SPEECH SYNTHESIS
     SpeechSynthesis has a ~200-char limit bug in some browsers.
     We chunk by sentence, capped at ~180 chars.
  ══════════════════════════════════════════ */
  function chunkText(text, maxLen) {
    maxLen = maxLen || 180;
    if (text.length <= maxLen) return [text];
    const chunks = [];
    /* split on sentence endings first */
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
        /* empty = short pause via an utterance with a space */
        const pause = new SpeechSynthesisUtterance(' ');
        pause.volume = 0;
        pause.rate = rate;
        all.push(pause);
        return;
      }
      const chunks = chunkText(part);
      chunks.forEach(function(chunk) {
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

  /* ══════════════════════════════════════════
     5. ESTIMATED DURATION (word-count based)
  ══════════════════════════════════════════ */
  function estimateDuration(script, rate) {
    const fullText = script.join(' ');
    const wordCount = fullText.trim().split(/\s+/).length;
    /* average 150 wpm at rate=1, adjusted */
    return Math.round((wordCount / (150 * rate)) * 60);
  }

  function formatTime(secs) {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* ══════════════════════════════════════════
     6. VOICE LOADING
  ══════════════════════════════════════════ */
  function loadVoices() {
    voices = synth.getVoices();
    if (!voices.length) return;
    populateVoiceSelect();
    selectDefaultVoice();
  }

  function populateVoiceSelect() {
    if (!voiceSelect) return;
    voiceSelect.innerHTML = '';
    const englishVoices = voices.filter(function(v) {
      return v.lang.startsWith('en');
    });
    const list = englishVoices.length ? englishVoices : voices;
    list.forEach(function(v, i) {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = v.name.replace('Google ', '').replace('Microsoft ', '').substring(0, 22);
      opt.dataset.idx = voices.indexOf(v);
      voiceSelect.appendChild(opt);
    });
  }

  function selectDefaultVoice() {
    /* Priority: female English voices */
    const femaleKeywords = ['female', 'woman', 'girl', 'zira', 'samantha', 'victoria', 'fiona',
                            'karen', 'moira', 'susan', 'veena', 'tessa', 'serena', 'alice',
                            'allison', 'ava', 'joanna', 'aria', 'jenny', 'sonia', 'libby'];
    const englishVoices = voices.filter(function(v) { return v.lang.startsWith('en'); });
    const pool = englishVoices.length ? englishVoices : voices;

    let best = pool.find(function(v) {
      const name = v.name.toLowerCase();
      return femaleKeywords.some(function(k) { return name.includes(k); });
    });

    if (!best) {
      /* fallback: any en-GB or en-US */
      best = pool.find(function(v) { return v.lang === 'en-GB' || v.lang === 'en-US'; });
    }
    if (!best) best = pool[0];

    selectedVoice = best || null;

    /* sync select UI */
    if (voiceSelect && best) {
      const allVoices = voices;
      const targetIdx = allVoices.indexOf(best);
      Array.from(voiceSelect.options).forEach(function(opt) {
        if (parseInt(opt.dataset.idx) === targetIdx) {
          opt.selected = true;
        }
      });
    }
  }

  synth.onvoiceschanged = loadVoices;
  loadVoices();

  /* ══════════════════════════════════════════
     7. PLAYBACK ENGINE
  ══════════════════════════════════════════ */
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

  function speakFrom(idx) {
    if (idx >= utterances.length) {
      onPlaybackEnd();
      return;
    }
    const u = utterances[idx];

    u.onstart = function() {
      isPlaying = true;
      isPaused  = false;
      updatePlayUI(true);
      if (!timerInterval) {
        if (!startTime) {
          startTime = Date.now() - (elapsedSecs * 1000);
        }
        startTimer();
      }
    };

    u.onend = function() {
      currentIdx = idx + 1;
      updateProgress();
      speakFrom(currentIdx);
    };

    u.onerror = function(e) {
      /* skip interrupted errors (these are normal when pausing/stopping) */
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      setStatus('Voice error — trying to continue...');
      currentIdx = idx + 1;
      speakFrom(currentIdx);
    };

    synth.speak(u);
    setStatus('Reading aloud...');
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

  /* ── Play / Pause toggle ── */
  function togglePlay() {
    if (!isPlaying && !isPaused) {
      /* Fresh start */
      elapsedSecs = 0;
      startTime   = null;
      buildAndPlay();
    } else if (isPlaying && !isPaused) {
      synth.cancel();
      isPaused      = true;
      isPlaying     = false;
      /* Save exactly where we are so resume starts at same chunk */
      updatePlayUI(false);
      stopTimer();
      setStatus('Paused.');
    } else if (isPaused) {
      /* Resume from the exact chunk that was playing when paused */
      isPaused  = false;
      isPlaying = false;
      startTime = Date.now() - (elapsedSecs * 1000);
      speakFrom(currentIdx);
    }
  }

  function stopPlayback() {
    synth.cancel();
    isPlaying = false;
    isPaused  = false;
    startTime = null;
    elapsedSecs = 0;
    currentIdx = 0;
    stopTimer();
    updatePlayUI(false);
    updateProgress(0);
    if (timeElapsed) timeElapsed.textContent = '0:00';
    setStatus('Stopped.');
    if (fabLabel) fabLabel.textContent = 'Listen';
  }

  /* ══════════════════════════════════════════
     8. UI HELPERS
  ══════════════════════════════════════════ */
  function updatePlayUI(playing) {
    /* swap play/pause icon */
    if (btnPlay) {
      btnPlay.innerHTML = playing
        ? '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
        : '<svg viewBox="0 0 24 24"><polygon points="5,3 19,12 5,21"/></svg>';
      btnPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    }
    /* wave animation */
    if (wave) wave.classList.toggle('ap-wave-active', playing);
    /* trigger button pulse */
    if (trigger) trigger.classList.toggle('ap-playing', playing);
    /* fab label */
    if (fabLabel && !playing && !isPaused) {
      /* keep current label unless fully stopped */
    }
  }

  function updateProgress(force) {
    if (!progressFill) return;
    const pct = (force !== undefined)
      ? force
      : (totalChunks > 0 ? currentIdx / totalChunks : 0);
    progressFill.style.width = (Math.min(pct, 1) * 100) + '%';
  }

  function setStatus(msg, active) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.classList.toggle('ap-status-active', !!active || isPlaying);
  }

  /* ── Timer ── */
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

  /* ══════════════════════════════════════════
     9. PLAYER OPEN / CLOSE
  ══════════════════════════════════════════ */
  function openPlayer() {
    player.classList.add('ap-open');
    trigger.setAttribute('aria-expanded', 'true');
    /* Set post title in player header */
    const titleEl = document.getElementById('ap-post-title');
    if (titleEl) {
      const h1 = document.querySelector('h1');
      titleEl.textContent = h1 ? h1.innerText.trim() : document.title;
    }
    /* Set duration estimate */
    const script = extractReadingScript();
    estimatedDuration = estimateDuration(script, currentRate);
    if (timeDuration) timeDuration.textContent = formatTime(estimatedDuration);
  }

  function closePlayer() {
    player.classList.remove('ap-open');
    trigger.setAttribute('aria-expanded', 'false');
    /* do NOT stop playback — reader can close panel and keep listening */
  }

  /* ══════════════════════════════════════════
     10. EVENT LISTENERS
  ══════════════════════════════════════════ */
  trigger.addEventListener('click', function() {
    if (player.classList.contains('ap-open')) {
      closePlayer();
    } else {
      openPlayer();
    }
  });

  if (btnClose) {
    btnClose.addEventListener('click', closePlayer);
  }

  if (btnPlay) {
    btnPlay.addEventListener('click', togglePlay);
  }

  if (btnStop) {
    btnStop.addEventListener('click', stopPlayback);
  }

  /* Speed buttons */
  speedBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      const rate = parseFloat(btn.dataset.rate);
      if (isNaN(rate)) return;
      currentRate = rate;
      speedBtns.forEach(function(b) { b.classList.remove('ap-active'); });
      btn.classList.add('ap-active');
      /* Rebuild utterances at new rate and resume from current position */
      if (isPlaying || isPaused) {
        const savedIdx = currentIdx;
        const savedElapsed = elapsedSecs;
        synth.cancel();
        isPlaying = false;
        isPaused  = false;
        stopTimer();
        const script = extractReadingScript();
        utterances  = buildUtterances(script, currentRate, selectedVoice);
        totalChunks = utterances.length;
        currentIdx  = savedIdx < totalChunks ? savedIdx : 0;
        elapsedSecs = savedElapsed;
        startTime   = null;
        speakFrom(currentIdx);
      }
    });
  });

  /* Voice selector */
  if (voiceSelect) {
    voiceSelect.addEventListener('change', function() {
      const idx = parseInt(voiceSelect.options[voiceSelect.selectedIndex].dataset.idx);
      selectedVoice = voices[idx] || null;
      if (isPlaying || isPaused) {
        const wasIdx = currentIdx;
        stopPlayback();
        /* Brief delay then resume from scratch */
        setTimeout(function() { buildAndPlay(); }, 80);
      }
    });
  }

  /* ── Initial state ── */
  updatePlayUI(false);
  updateProgress(0);
  setStatus('Tap play to listen to this post.');

  /* ── Cleanup on page hide (mobile browser tab switch) ── */
  document.addEventListener('visibilitychange', function() {
    if (document.hidden && isPlaying) {
      /* keep playing — reader is on another tab, speech continues */
    }
  });

  /* ── Stop speech if user navigates away ── */
  window.addEventListener('beforeunload', function() {
    synth.cancel();
  });

})();
