// ==UserScript==
// @name         ListenLive (WJJO) ad-break auto-mute + preroll skip
// @namespace    cwald.listenlive
// @version      1.3.0
// @description  Fades out the Triton/listenlive.co web player while the station reports a commercial break, and skips the pre-roll ad so the station starts immediately.
// @match        https://player.listenlive.co/72051/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[ll-admute]';
  const SKIP_PREROLL = true;        // stretch goal: don't play the pre-roll VAST ad
  const MAX_BREAK_MS = 8 * 60e3;    // safety: never stay muted longer than this
  const FADE_MS = 1000;             // fade in/out duration
  const KEEPALIVE_GAIN = 0.002;     // ~-60 dBFS of noise: above Chrome's -72 dBFS "audible" floor, below yours
  const DOM_CUE_GRACE_MS = 5000;    // ignore the DOM-text fallback this soon after a real cue event
  const log = (...a) => console.log(TAG, ...a);

  // ---------------------------------------------------------------------
  // 1. Capture the SDK's media element. The TD SDK plays through an
  //    un-attached `new Audio()` node, so querySelector can't find it.
  //    Wrapping HTMLMediaElement.prototype.play at document-start does.
  // ---------------------------------------------------------------------
  const mediaNodes = new Set();
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (!mediaNodes.has(this)) {
      mediaNodes.add(this);
      this.addEventListener('volumechange', onVolumeChange);
      this.addEventListener('playing', () => { this.__llPlayingAt = performance.now(); });
      this.addEventListener('pause', () => { this.__llPlayingAt = 0; });
      this.addEventListener('emptied', () => { this.__llPlayingAt = 0; });
      // timeupdate keeps firing while the stream plays, even when DOM timers
      // are throttled, so it doubles as a watchdog tick for the break deadline.
      this.addEventListener('timeupdate', checkDeadline);
      log('captured media element', this.tagName, this.src && this.src.slice(0, 80));
      if (inBreak) applyMute(this, true);
    }
    return origPlay.apply(this, arguments);
  };

  // ---------------------------------------------------------------------
  // 2. Mute state, with a 1 s perceptual (quadratic) fade instead of a hard cut
  // ---------------------------------------------------------------------
  let inBreak = false;
  let breakTimer = null;
  let breakStartedAt = 0;                // performance.now() when the break began
  const fades = new WeakMap();           // el -> interval handle while a ramp runs

  // Ramp el.volume from its current value to `to` over `ms`. Progress is
  // computed from elapsed wall time, so a throttled background tab makes
  // the fade coarser but never longer. Amplitude follows a quadratic curve
  // (v = a*k^2 up, v = a*(1-k)^2 down), which is close to a linear change in
  // perceived loudness.
  function fadeTo(el, to, ms, done) {
    clearInterval(fades.get(el));
    const from = el.volume, t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      const e = to > from ? k * k : 1 - (1 - k) * (1 - k);
      try { el.volume = from + (to - from) * e; } catch (err) { /* read-only volume (iOS) */ }
      if (k >= 1) { clearInterval(fades.get(el)); fades.delete(el); done && done(); }
    };
    fades.set(el, setInterval(step, 20));
    step();
  }
  const isFading = el => fades.has(el);

  // Volume to come back to: the player's own setting (tracks the slider even
  // if it was moved mid-break), else whatever we saw before fading out.
  function restoreVolume(el) {
    const app = window.application;
    const v = app && app.player && typeof app.player._volume === 'number' ? app.player._volume : el.__llRestore;
    return typeof v === 'number' && v >= 0 && v <= 1 ? v : 1;
  }

  // Nothing has been heard from this element yet (pre-roll about to start,
  // stream joined mid-break, element still buffering) -> cut, don't fade.
  function nothingToFade(el) {
    return el.paused || !el.__llPlayingAt || performance.now() - el.__llPlayingAt < FADE_MS;
  }

  function applyMute(el, muted, immediate) {
    // In a hidden tab the fade's setInterval is throttled (1 s, or 1 min once
    // the tab has been silent a while) or frozen, so a "fade" is really a
    // delayed hard cut. Nobody is watching the ramp anyway: cut now.
    if (document.hidden) immediate = true;
    if (muted && !immediate && nothingToFade(el)) immediate = true;
    if (muted) {
      if (!isFading(el) && !el.muted) el.__llRestore = el.volume;
      if (immediate) { clearInterval(fades.get(el)); fades.delete(el); el.volume = 0; el.muted = true; log('  cut', el.tagName); return; }
      log('  fade', el.tagName);
      fadeTo(el, 0, FADE_MS, () => { el.muted = true; });
    } else {
      const target = restoreVolume(el);
      el.muted = false;
      if (immediate) { clearInterval(fades.get(el)); fades.delete(el); el.volume = target; return; }
      fadeTo(el, target, FADE_MS);
    }
  }

  // The SDK's own setVolume() flips `muted = false` when the user touches
  // the volume slider. Re-mute while a break is active (our own ramps are
  // recognised via isFading and left alone).
  function onVolumeChange(e) {
    const el = e.target;
    if (inBreak && !isFading(el) && !el.muted) { el.volume = 0; el.muted = true; }
  }

  // ---------------------------------------------------------------------
  // 2b. Keep the tab "audible" while the station is muted.
  //
  // Chrome/Edge measure the actual audio output; a muted element makes the
  // tab silent, and a hidden silent tab loses its exemptions: DOM timers go
  // to one wakeup per minute after 30 s of silence, and Energy Saver can
  // freeze the page entirely. The SDK's cue-point delivery, our fades and
  // the safety timeout all ride on those timers, which is why the un-mute
  // used to sit queued until the tab was focused again. A loop of white
  // noise at ~-60 dBFS keeps the tab audible to the browser but not to you.
  // ---------------------------------------------------------------------
  let keepCtx = null, keepSrc = null;
  function keepAlive(on) {
    try {
      if (on && !keepSrc) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        keepCtx = keepCtx || new AC();
        const buf = keepCtx.createBuffer(1, keepCtx.sampleRate, keepCtx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        const src = keepCtx.createBufferSource();
        src.buffer = buf; src.loop = true;
        const g = keepCtx.createGain(); g.gain.value = KEEPALIVE_GAIN;
        src.connect(g).connect(keepCtx.destination);
        src.start();
        keepSrc = src;
        // Play was clicked earlier, so the page has sticky activation and
        // resume() is allowed; if it isn't, we just lose the keep-alive.
        keepCtx.resume().then(() => log('keep-alive on', keepCtx.state), () => log('keep-alive resume refused'));
      } else if (!on && keepSrc) {
        try { keepSrc.stop(); } catch (err) { /* already stopped */ }
        keepSrc.disconnect();
        keepSrc = null;
        log('keep-alive off');
      }
    } catch (err) { log('keep-alive error', err); }
  }

  let breakWhy = '';
  function setBreak(active, why, immediate) {
    if (active === inBreak) return;
    inBreak = active;
    breakWhy = active ? why : '';
    breakStartedAt = active ? performance.now() : 0;
    log(active ? 'AD BREAK -> silencing' : 'break over -> fading in', '(' + why + ')');
    keepAlive(active);                       // before muting, so the tab never goes silent
    mediaNodes.forEach(el => applyMute(el, active, immediate));
    badge(active);
    clearTimeout(breakTimer);
    if (active) breakTimer = setTimeout(checkDeadline, MAX_BREAK_MS);
  }

  // Safety deadline on the wall clock rather than trusting one setTimeout.
  // Called from the timeout itself, from media timeupdate ticks, and when the
  // tab becomes visible again, so a throttled or frozen timer can't strand
  // the mute past MAX_BREAK_MS.
  function checkDeadline() {
    if (inBreak && breakStartedAt && performance.now() - breakStartedAt >= MAX_BREAK_MS) {
      setBreak(false, 'safety timeout', true);
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    checkDeadline();
    // If a break ended while hidden, the cut already happened; nothing to do.
    // If one is still active, make sure every element is really silenced.
    if (inBreak) mediaNodes.forEach(el => { if (!el.muted) applyMute(el, true, true); });
  });

  // Small on-page indicator so you can see it working.
  let badgeEl = null;
  function badge(show) {
    if (!document.body) return;
    if (!badgeEl) {
      badgeEl = document.createElement('div');
      badgeEl.textContent = 'AD BREAK – MUTED';
      Object.assign(badgeEl.style, {
        position: 'fixed', top: '8px', right: '8px', zIndex: 2147483647,
        padding: '4px 10px', borderRadius: '4px', font: 'bold 12px sans-serif',
        background: '#c00', color: '#fff', pointerEvents: 'none', display: 'none'
      });
      document.body.appendChild(badgeEl);
    }
    badgeEl.style.display = show ? 'block' : 'none';
  }

  // ---------------------------------------------------------------------
  // 3. Hook the player once the app has booted (require.js loads it async).
  // ---------------------------------------------------------------------
  let lastCueAt = 0;                       // last time a real SDK cue event arrived
  function hookApi(api) {
    api.addEventListener('ad-break-cue-point', e => {
      lastCueAt = performance.now();
      const cp = e && e.data && e.data.cuePoint;
      const type = cp && cp.adType ? String(cp.adType).toLowerCase() : '';
      log('ad-break-cue-point', type, cp && cp.duration ? cp.duration + 'ms' : '');
      if (type === 'endbreak') setBreak(false, 'endbreak cue');
      else setBreak(true, 'break cue');
    });
    api.addEventListener('ad-break-cue-point-complete', () => { lastCueAt = performance.now(); setBreak(false, 'cue-point-complete'); });
    // Pre-roll (only plays when SKIP_PREROLL is off or the skip failed). There
    // is no audio before it, so it starts muted rather than fading out.
    api.addEventListener('ad-playback-start', () => setBreak(true, 'preroll', true));
    api.addEventListener('ad-playback-complete', () => breakWhy === 'preroll' && setBreak(false, 'preroll done'));
    api.addEventListener('ad-playback-error', () => breakWhy === 'preroll' && setBreak(false, 'preroll error'));
    api.addEventListener('stream-start', () => breakWhy === 'preroll' && setBreak(false, 'stream start'));
    // A song cue point means the station is back regardless of what the
    // break cues said; a stream stop means nothing to mute.
    api.addEventListener('track-cue-point', () => { lastCueAt = performance.now(); inBreak && setBreak(false, 'track cue'); });
    api.addEventListener('stream-stop', () => inBreak && setBreak(false, 'stream stop'));
    api.addEventListener('stream-error', () => inBreak && setBreak(false, 'stream error'));
    log('hooked TD SDK events');
  }

  function hookPreroll(app) {
    const enh = app.enhancements;
    if (!enh) return;
    // _onWillPlay() only calls the ad servers when prerollComplete is false
    // and station.hasPreroll() is true. Pin both.
    try {
      Object.defineProperty(enh, 'prerollComplete', { get: () => true, set() {}, configurable: true });
    } catch (err) { enh.prerollComplete = true; }
    if (app.station && typeof app.station.hasPreroll === 'function') app.station.hasPreroll = () => false;
    log('preroll disabled');
  }

  // Fallback: the player writes "In a commercial break..." into the
  // now-playing area. Watch for that text in case a cue event is missed.
  // Symmetric and deferential to the SDK: it only starts a break when no
  // real cue arrived recently (stale text used to re-mute right after the
  // endbreak cue, and news has no track cue to rescue it), and it ends a
  // break it started itself once the text goes away.
  function hookDom() {
    const target = document.getElementById('nowPlayingDisplay') || document.body;
    if (!target) return;
    const check = () => {
      const txt = target.textContent || '';
      const says = /in a commercial break/i.test(txt);
      const sinceCue = performance.now() - lastCueAt;
      if (says && !inBreak && sinceCue > DOM_CUE_GRACE_MS) setBreak(true, 'DOM text');
      else if (!says && inBreak && breakWhy === 'DOM text') setBreak(false, 'DOM text cleared');
    };
    new MutationObserver(check).observe(target, { childList: true, subtree: true, characterData: true });
    check();
  }

  let tries = 0;
  const poll = setInterval(() => {
    const app = window.application;
    const api = app && app.player && app.player.api;
    if (api && typeof api.addEventListener === 'function') {
      clearInterval(poll);
      hookApi(api);
      if (SKIP_PREROLL) hookPreroll(app);
      hookDom();
      window.__llAdMute = { get inBreak() { return inBreak; }, setBreak, mediaNodes, keepAlive };
    } else if (++tries > 240) {           // 60 s
      clearInterval(poll);
      log('gave up waiting for window.application.player.api');
    }
  }, 250);
})();
