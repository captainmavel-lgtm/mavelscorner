/**
 * MAVEL'S CORNER — READ ALOUD PLAYER
 * File: src/assets/js/audio-player.js
 * v4.0 — Azure TTS + Cloudflare R2 MP3 — true background playback
 */

(function () {
  'use strict';

  /* ── DOM REFERENCES ── */
  const trigger       = document.getElementById('mc-audio-trigger');
  const player        = document.getElementById('mc-audio-player');
  const btnPlay       = document.getElementById('ap-btn-play');
  const btnStop       = document.getElementById('ap-btn-stop');
  const btnClose      = document.getElementById('ap-close');
  const btnDownload   = document.getElementById('ap-btn-download');
  const wave          = document.getElementById('ap-wave');
  const progressTrack = document.getElementById('ap-progress-track');
  const progressFill  = document.getElementById('ap-progress-fill');
  const progressThumb = document.getElementById('ap-progress-thumb');
  const timeElapsed   = document.getElementById('ap-time-elapsed');
  const timeDuration  = document.getElementById('ap-time-duration');
  const statusEl      = document.getElementById('ap-status');
  const fabLabel      = document.getElementById('ap-fab-label');
  const speedBtns     = document.querySelectorAll('.ap-speed-btn');
  const volumeSlider  = document.getElementById('ap-volume-slider');
  const volumePct     = document.getElementById('ap-volume-pct');
  const genderBtns    = document.querySelectorAll('.ap-gender-btn');
  const voiceSelect   = document.getElementById('ap-voice-select');

  if (!trigger || !player || !btnPlay) return;

  /* ── AUDIO ELEMENT ── */
  const audio = new Audio();
  audio.preload = 'none';

  /* ── STATE ── */
  let audioUrl       = null;
  let isGenerating   = false;
  let currentGender  = 'female';
  let timerInterval  = null;

  /* ── VOICE MAP ── */
  const VOICES = {
    female: [
      { label: 'Clara (Canada)',    value: 'en-CA-ClaraNeural'    },
      { label: 'Jenny (US)',        value: 'en-US-JennyNeural'    },
      { label: 'Sonia (UK)',        value: 'en-GB-SoniaNeural'    },
      { label: 'Natasha (AU)',      value: 'en-AU-NatashaNeural'  }
    ],
    male: [
      { label: 'Liam (Canada)',     value: 'en-CA-LiamNeural'     },
      { label: 'Guy (US)',          value: 'en-US-GuyNeural'      },
      { label: 'Ryan (UK)',         value: 'en-GB-RyanNeural'     },
      { label: 'William (AU)',      value: 'en-AU-WilliamNeural'  }
    ]
  };

  let selectedVoice = VOICES.female[0].value;

  /* ── STORAGE ── */
  const STORAGE_KEY = 'mc_audio_v4_' + window.location.pathname;
  const VOLUME_KEY  = 'mc_audio_volume';

  /* ── RESTORE VOLUME ── */
  (function () {
    var saved = localStorage.getItem(VOLUME_KEY);
    if (saved !== null) {
      audio.volume = Math.min(1, Math.max(0, parseFloat(saved) || 1));
      if (volumeSlider) volumeSlider.value = Math.round(audio.volume * 100);
      updateVolumeUI();
    }
  })();

  /* ============================================================
     CONTENT EXTRACTION — same logic as before
  ============================================================ */
  function extractPostText() {
    const postContent = document.querySelector('.article-inner');
    if (!postContent) return '';

    const parts = [];

    const h1 = document.querySelector('h1');
    if (h1) parts.push(h1.innerText.trim() + '.');

    const dateEl = document.querySelector('.post-meta-date');
    let byline = "Written by Emmanuel, on Mavel's Corner.";
    if (dateEl) byline += ' ' + dateEl.innerText.trim() + '.';
    parts.push(byline);
    parts.push('');

    const skipSelectors = [
      'nav', 'footer', '.tags', '.hashtags', '.post-tags',
      '.share-buttons', '.share-row', '[class*="share"]',
      '.article-share', '[class*="prayer-form"]', '.post-footer',
      'script', 'style', 'noscript'
    ];

    function shouldSkip(el) {
      return skipSelectors.some(function (sel) {
        try { return el.closest(sel); } catch(e) { return false; }
      });
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
          parts.push('Scripture: ' + text
            .replace(/[\u2018\u2019]/g, "'")
            .replace(/[\u201C\u201D]/g, '"'));
        }
      } else if (tag === 'li') {
        const text = node.innerText.trim();
        if (text && !isHashtagLine(text)) parts.push(text + '.');
      }

      node = walker.nextNode();
    }

    parts.push('');
    parts.push("That is the end of this post. Thank you for reading along with Mavel's Corner. God bless you.");

    return parts.filter(Boolean).join('\n');
  }

  /* ============================================================
     AUDIO GENERATION
  ============================================================ */
  async function generateAudio() {
    if (isGenerating) return;
    isGenerating = true;

    setStatus('Generating audio... this takes a few seconds on first listen.', true);
    updatePlayUI(false, true);

    const text     = extractPostText();
    const postSlug = window.location.pathname.replace(/\//g, '-').replace(/^-|-$/g, '') || 'post';

    try {
      const res = await fetch('/.netlify/functions/generate-audio', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text, postSlug, voice: selectedVoice })
      });

      if (!res.ok) throw new Error('Generation failed: ' + res.status);

      const data = await res.json();
      audioUrl   = data.url;

      // Save for resume
      saveProgress(0);

      // Set audio source and play
      audio.src = audioUrl;
      audio.load();
      await audio.play();

      isGenerating = false;
      setStatus('Playing...', true);
      updatePlayUI(true, false);
      if (fabLabel) fabLabel.textContent = 'Listening';

      // Enable download button
      if (btnDownload) {
        btnDownload.href     = audioUrl;
        btnDownload.download = postSlug + '.mp3';
        btnDownload.style.display = 'inline-flex';
      }

    } catch (e) {
      isGenerating = false;
      console.error('Audio generation error:', e);
      setStatus('Could not generate audio. Please try again.');
      updatePlayUI(false, false);
    }
  }

  /* ============================================================
     PLAYBACK CONTROLS
  ============================================================ */
  function togglePlay() {
    if (isGenerating) return;

    if (!audioUrl) {
      generateAudio();
      return;
    }

    if (audio.paused) {
      audio.play().then(function () {
        setStatus('Playing...', true);
        updatePlayUI(true, false);
      }).catch(function (e) {
        setStatus('Playback error. Please try again.');
      });
    } else {
      audio.pause();
      setStatus('Paused.');
      updatePlayUI(false, false);
    }
  }

  function stopPlayback() {
    audio.pause();
    audio.currentTime = 0;
    audioUrl = null;
    audio.src = '';
    setStatus('Stopped.');
    updatePlayUI(false, false);
    setProgressVisual(0);
    if (timeElapsed)  timeElapsed.textContent  = '0:00';
    if (timeDuration) timeDuration.textContent = '--:--';
    if (fabLabel)     fabLabel.textContent     = 'Listen';
    if (btnDownload)  btnDownload.style.display = 'none';
    clearProgress();
  }

  /* ============================================================
     AUDIO EVENTS
  ============================================================ */
  audio.addEventListener('timeupdate', function () {
    if (!audio.duration) return;
    const pct = audio.currentTime / audio.duration;
    setProgressVisual(pct);
    if (timeElapsed) timeElapsed.textContent = formatTime(audio.currentTime);
    saveProgress(audio.currentTime);
  });

  audio.addEventListener('loadedmetadata', function () {
    if (timeDuration) timeDuration.textContent = formatTime(audio.duration);
  });

  audio.addEventListener('ended', function () {
    setStatus('Finished. Play again to restart.');
    updatePlayUI(false, false);
    setProgressVisual(1);
    if (fabLabel) fabLabel.textContent = 'Listen Again';
    clearProgress();
  });

  audio.addEventListener('play', function () {
    updatePlayUI(true, false);
    wave && wave.classList.add('ap-wave-active');
  });

  audio.addEventListener('pause', function () {
    updatePlayUI(false, false);
    wave && wave.classList.remove('ap-wave-active');
  });

  audio.addEventListener('waiting', function () {
    setStatus('Buffering...', true);
  });

  audio.addEventListener('canplay', function () {
    if (!audio.paused) setStatus('Playing...', true);
  });

  /* ============================================================
     PROGRESS BAR — DRAGGABLE
  ============================================================ */
  function seekToPercent(pct) {
    if (!audio.duration) return;
    audio.currentTime = pct * audio.duration;
    setProgressVisual(pct);
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

  if (progressTrack) {
    /* Mouse */
    progressTrack.addEventListener('mousedown', function (e) {
      e.preventDefault();
      progressFill && progressFill.classList.remove('ap-smooth');
      progressTrack.classList.add('ap-dragging');

      function onMove(e2) { setProgressVisual(getTrackPct(e2.clientX)); }
      function onUp(e2) {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
        progressFill && progressFill.classList.add('ap-smooth');
        progressTrack.classList.remove('ap-dragging');
        seekToPercent(getTrackPct(e2.clientX));
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
      setProgressVisual(getTrackPct(e.clientX));
    });

    /* Touch */
    progressTrack.addEventListener('touchstart', function (e) {
      e.preventDefault();
      progressFill && progressFill.classList.remove('ap-smooth');
      var pct = getTrackPct(e.touches[0].clientX);
      setProgressVisual(pct);

      function onMove(e2) { pct = getTrackPct(e2.touches[0].clientX); setProgressVisual(pct); }
      function onEnd() {
        progressTrack.removeEventListener('touchmove', onMove);
        progressTrack.removeEventListener('touchend',  onEnd);
        progressFill && progressFill.classList.add('ap-smooth');
        seekToPercent(pct);
      }
      progressTrack.addEventListener('touchmove', onMove, { passive: false });
      progressTrack.addEventListener('touchend',  onEnd);
    }, { passive: false });

    /* Keyboard */
    progressTrack.addEventListener('keydown', function (e) {
      if (!audio.duration) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); audio.currentTime = Math.min(audio.duration, audio.currentTime + 10); }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); audio.currentTime = Math.max(0, audio.currentTime - 10); }
    });
  }

  /* ============================================================
     SPEED
  ============================================================ */
  speedBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var rate = parseFloat(btn.dataset.rate);
      if (isNaN(rate)) return;
      audio.playbackRate = rate;
      speedBtns.forEach(function (b) { b.classList.remove('ap-active'); });
      btn.classList.add('ap-active');
    });
  });

  /* ============================================================
     VOLUME
  ============================================================ */
  function updateVolumeUI() {
    if (!volumeSlider) return;
    const pct = Math.round(audio.volume * 100);
    if (volumePct) volumePct.textContent = pct + '%';
    volumeSlider.style.background =
      'linear-gradient(to right, var(--ap-teal) 0%, var(--ap-teal) ' + pct + '%, rgba(255,255,255,0.10) ' + pct + '%, rgba(255,255,255,0.10) 100%)';
  }

  if (volumeSlider) {
    volumeSlider.addEventListener('input', function () {
      audio.volume = parseInt(volumeSlider.value) / 100;
      localStorage.setItem(VOLUME_KEY, audio.volume);
      updateVolumeUI();
    });
  }

  updateVolumeUI();

  /* ============================================================
     GENDER + VOICE SELECT
  ============================================================ */
  function populateVoiceDropdown(gender) {
    if (!voiceSelect) return;
    voiceSelect.innerHTML = '';
    VOICES[gender].forEach(function (v) {
      var opt       = document.createElement('option');
      opt.value     = v.value;
      opt.textContent = v.label;
      if (v.value === selectedVoice) opt.selected = true;
      voiceSelect.appendChild(opt);
    });
  }

  function applyGender(gender) {
    currentGender = gender;
    selectedVoice = VOICES[gender][0].value;
    populateVoiceDropdown(gender);

    genderBtns.forEach(function (b) {
      var active = b.dataset.gender === gender;
      b.classList.toggle('ap-active', active);
      b.setAttribute('aria-pressed', String(active));
    });

    /* If audio already generated, reset so it regenerates with new voice */
    if (audioUrl) {
      stopPlayback();
      setStatus('Voice changed. Tap play to regenerate with new voice.');
    }
  }

  genderBtns.forEach(function (btn) {
    btn.addEventListener('click', function () { applyGender(btn.dataset.gender); });
  });

  if (voiceSelect) {
    voiceSelect.addEventListener('change', function () {
      selectedVoice = voiceSelect.value;
      if (audioUrl) {
        stopPlayback();
        setStatus('Voice changed. Tap play to regenerate.');
      }
    });
  }

  /* Initialise voice dropdown */
  populateVoiceDropdown('female');

  /* ============================================================
     RESUME MEMORY
  ============================================================ */
  function saveProgress(currentTime) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ url: audioUrl, time: currentTime })); }
    catch (e) {}
  }

  function loadProgress() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  function clearProgress() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }

  function checkResume() {
    var saved = loadProgress();
    if (!saved || !saved.url || saved.time < 2) return;

    var prompt  = document.getElementById('ap-resume-prompt');
    var text    = document.getElementById('ap-resume-text');
    var yesBtn  = document.getElementById('ap-resume-yes');
    var noBtn   = document.getElementById('ap-resume-no');

    if (!prompt) return;

    var pct = audio.duration ? Math.round((saved.time / audio.duration) * 100) : 0;
    if (text) text.textContent = 'Resume from ' + formatTime(saved.time) + ' into this post?';
    prompt.classList.add('ap-visible');

    if (yesBtn) {
      yesBtn.onclick = function () {
        prompt.classList.remove('ap-visible');
        audioUrl   = saved.url;
        audio.src  = saved.url;
        audio.load();
        audio.currentTime = saved.time;
        audio.play();
        if (btnDownload) {
          var slug = window.location.pathname.replace(/\//g, '-').replace(/^-|-$/g, '');
          btnDownload.href     = saved.url;
          btnDownload.download = slug + '.mp3';
          btnDownload.style.display = 'inline-flex';
        }
      };
    }

    if (noBtn) {
      noBtn.onclick = function () {
        prompt.classList.remove('ap-visible');
        clearProgress();
      };
    }
  }

  /* ============================================================
     KEYBOARD SHORTCUTS
  ============================================================ */
  document.addEventListener('keydown', function (e) {
    if (!player.classList.contains('ap-open')) return;
    const tag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
    if (['input','textarea','select'].includes(tag)) return;
    if (document.activeElement === progressTrack) return;

    switch (e.key) {
      case ' ':
      case 'Spacebar':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + 10);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (audio.duration) audio.currentTime = Math.max(0, audio.currentTime - 10);
        break;
      case 'Escape':
        closePlayer();
        break;
    }
  });

  /* ============================================================
     UI HELPERS
  ============================================================ */
  function updatePlayUI(playing, loading) {
    if (btnPlay) {
      if (loading) {
        btnPlay.innerHTML = '<svg viewBox="0 0 24 24" class="ap-spin"><circle cx="12" cy="12" r="9" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="28" stroke-linecap="round"/></svg>';
        btnPlay.setAttribute('aria-label', 'Loading');
      } else {
        btnPlay.innerHTML = playing
          ? '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
          : '<svg viewBox="0 0 24 24"><polygon points="5,3 19,12 5,21"/></svg>';
        btnPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      }
    }
    if (wave) wave.classList.toggle('ap-wave-active', playing);
    if (trigger) trigger.classList.toggle('ap-playing', playing);
  }

  function setStatus(msg, active) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.classList.toggle('ap-status-active', !!active);
  }

  function formatTime(secs) {
    if (!secs || isNaN(secs)) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
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

    checkResume();
  }

  function closePlayer() {
    player.classList.remove('ap-open');
    trigger.setAttribute('aria-expanded', 'false');
    var prompt = document.getElementById('ap-resume-prompt');
    if (prompt) prompt.classList.remove('ap-visible');
  }

  /* ============================================================
     EVENT LISTENERS
  ============================================================ */
  trigger.addEventListener('click', function () {
    player.classList.contains('ap-open') ? closePlayer() : openPlayer();
  });

  if (btnClose) btnClose.addEventListener('click', closePlayer);
  if (btnPlay)  btnPlay.addEventListener('click',  togglePlay);
  if (btnStop)  btnStop.addEventListener('click',  stopPlayback);

  /* ============================================================
     INITIAL STATE
  ============================================================ */
  updatePlayUI(false, false);
  setProgressVisual(0);
  setStatus('Tap play to listen to this post.');

  window.addEventListener('beforeunload', function () { audio.pause(); });

})();
