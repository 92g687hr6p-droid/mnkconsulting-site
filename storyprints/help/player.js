/* StoryPrints help: plays a chapter made of animated scenes.
 *
 * Each scene is a <figure class="scene" data-duration="15" data-title="...">
 * holding one <svg> whose animation is SVG SMIL (so each scene has its own
 * clock that can be paused, played and moved to any time) and a hidden
 * <ol class="beats"> of caption lines, each with data-at = the second it
 * starts. Scenes play one after another; captions follow the scene's clock.
 * With "reduce motion" on, each scene opens at its end with all its words.
 *
 * Read aloud (optional, off by default): the browser's own speech voices
 * speak each caption line as it appears. If a line is still being spoken
 * when the next one is due, the scene waits for it. The visitor picks the
 * voice and speed; the choice is remembered in this browser only.
 */
(function () {
  "use strict";

  var player = document.querySelector("[data-player]");
  if (!player) return;

  var scenes = Array.prototype.slice.call(player.querySelectorAll(".scene"));
  var stage = player.querySelector(".stage");
  var overlay = player.querySelector(".start-overlay");
  var nameEl = player.querySelector(".scene-name");
  var textEl = player.querySelector(".beat-text");
  var playBtn = player.querySelector(".play-btn");
  var prevBtn = player.querySelector(".prev-btn");
  var nextBtn = player.querySelector(".next-btn");
  var restartBtn = player.querySelector(".restart-btn");
  var seek = player.querySelector(".seek");
  var timeEl = player.querySelector(".time");
  var list = player.querySelector(".scene-list");

  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var current = 0;
  var playing = false;
  var started = false;
  var frame = 0;
  var lastBeat = null;

  var ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

  function svgOf(i) { return scenes[i].querySelector("svg"); }
  function durationOf(i) { return parseFloat(scenes[i].getAttribute("data-duration")) || 10; }
  function beatsOf(i) {
    return Array.prototype.slice.call(scenes[i].querySelectorAll(".beats li")).map(function (li) {
      return { at: parseFloat(li.getAttribute("data-at")) || 0, text: li.textContent.trim() };
    });
  }
  function timeOf(i) {
    try { return svgOf(i).getCurrentTime(); } catch (e) { return 0; }
  }
  function setTime(i, t) {
    try { svgOf(i).setCurrentTime(Math.max(0, t)); } catch (e) { /* not supported */ }
  }
  function fmt(t) {
    t = Math.max(0, Math.round(t));
    return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
  }

  // ---- Read aloud -------------------------------------------------------
  var synth = window.speechSynthesis;
  var narr = { on: false, voices: [], voice: null, rate: 1, spoken: -1, speaking: false, holding: false, token: 0, unlocked: false };
  var narrUI = null;

  function store(key, value) {
    try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (e) { /* storage blocked */ }
  }
  function stored(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function voiceRank(v) {
    var lang = (v.lang || "").toLowerCase().replace("_", "-");
    var r = lang === "en-gb" ? 0 : lang === "en-ie" || lang === "en-au" || lang === "en-nz" ? 2 : 4;
    if (/natural/i.test(v.name)) r -= 1;
    return r;
  }

  function loadVoices() {
    if (!synth || !narrUI) return;
    var all = synth.getVoices() || [];
    var english = all.filter(function (v) { return v.lang && /^en/i.test(v.lang); });
    english.sort(function (a, b) { return voiceRank(a) - voiceRank(b) || a.name.localeCompare(b.name); });
    if (!english.length) english = all.slice();
    narr.voices = english;
    if (!english.length) return;
    narrUI.box.hidden = false;
    var saved = stored("storyprints-help-voice");
    var keep = narr.voice ? narr.voice.voiceURI : saved;
    narrUI.voice.innerHTML = "";
    english.forEach(function (v, i) {
      var o = document.createElement("option");
      o.value = String(i);
      o.textContent = v.name.replace(/^Microsoft\s+/, "").replace(/\s*-\s*English.*$/, "") +
        " (" + v.lang + ")" + (v.localService ? "" : " · Online");
      narrUI.voice.appendChild(o);
    });
    var pick = 0;
    english.forEach(function (v, i) { if (v.voiceURI === keep) pick = i; });
    narrUI.voice.value = String(pick);
    narr.voice = english[pick];
    showVoiceNote();
  }

  function showVoiceNote() {
    if (narrUI) narrUI.note.hidden = !(narr.voice && narr.voice.localService === false);
  }

  function stopSpeech() {
    narr.token++;
    narr.speaking = false;
    narr.spoken = -1;
    if (synth) { try { synth.cancel(); } catch (e) { /* ignore */ } }
  }

  function releaseHold() {
    if (!narr.holding) return;
    narr.holding = false;
    if (playing) { try { svgOf(current).unpauseAnimations(); } catch (e) { /* ignore */ } }
  }

  function speakLine(text) {
    var token = ++narr.token;
    var u = new SpeechSynthesisUtterance(text.replace(/^[\s…]+|[\s…]+$/g, "").replace(/…/g, ", ").replace(/·/g, ","));
    if (narr.voice) { u.voice = narr.voice; u.lang = narr.voice.lang; } else { u.lang = "en-GB"; }
    u.rate = narr.rate;
    var finished = function () {
      if (token !== narr.token) return;
      narr.speaking = false;
      releaseHold();
    };
    u.onend = finished;
    u.onerror = finished;
    narr.speaking = true;
    narr.deadline = Date.now() + 4000 + text.length * 120 / narr.rate;
    try { synth.speak(u); } catch (e) { narr.speaking = false; }
  }

  // called on every frame while playing; returns true while the scene is held for speech
  function narrate(t) {
    if (!narr.on || !synth) return false;
    var beats = beatsOf(current);
    if (!beats.length) return false;
    // a voice that never reports it has finished must not stop the chapter
    if (narr.speaking && Date.now() > narr.deadline) { narr.token++; narr.speaking = false; releaseHold(); }
    var nextAt = narr.spoken >= 0 && narr.spoken + 1 < beats.length ? beats[narr.spoken + 1].at : durationOf(current);
    if (narr.speaking && narr.spoken >= 0 && t >= nextAt - 0.05) {
      if (!narr.holding) {
        narr.holding = true;
        try { svgOf(current).pauseAnimations(); } catch (e) { /* ignore */ }
      }
      return true;
    }
    var bi = 0;
    beats.forEach(function (b, k) { if (t + 0.01 >= b.at) bi = k; });
    if (bi !== narr.spoken && !narr.speaking && t < durationOf(current) - 0.05) {
      narr.spoken = bi;
      speakLine(beats[bi].text);
    }
    return false;
  }

  function buildNarrationUI() {
    if (!synth || typeof SpeechSynthesisUtterance === "undefined") return;
    var box = document.createElement("div");
    box.className = "narration";
    box.hidden = true;
    box.innerHTML =
      '<label class="read-aloud"><input type="checkbox"> Read aloud</label>' +
      '<label class="pick">Voice <select></select></label>' +
      '<label class="pick">Speed <select><option value="0.85">Slower</option><option value="1">Normal</option><option value="1.15">Faster</option></select></label>' +
      '<p class="voice-note" hidden>Online voice: your browser sends the captions to its maker (Microsoft or Google) to be spoken. Voices without “Online” work on this computer.</p>';
    var selects = box.querySelectorAll("select");
    narrUI = { box: box, toggle: box.querySelector("input"), voice: selects[0], rate: selects[1], note: box.querySelector(".voice-note") };
    player.insertBefore(box, list);

    narr.on = stored("storyprints-help-read-aloud") === "on";
    narrUI.toggle.checked = narr.on;
    var savedRate = stored("storyprints-help-rate");
    if (savedRate && narrUI.rate.querySelector('option[value="' + savedRate + '"]')) narrUI.rate.value = savedRate; else narrUI.rate.value = "1";
    narr.rate = parseFloat(narrUI.rate.value);

    narrUI.toggle.addEventListener("change", function () {
      narr.on = narrUI.toggle.checked;
      store("storyprints-help-read-aloud", narr.on ? "on" : null);
      stopSpeech();
      releaseHold();
      if (narr.on) unlockSpeech();
    });
    narrUI.voice.addEventListener("change", function () {
      narr.voice = narr.voices[parseInt(narrUI.voice.value, 10)] || null;
      store("storyprints-help-voice", narr.voice ? narr.voice.voiceURI : null);
      showVoiceNote();
      restartLine();
    });
    narrUI.rate.addEventListener("change", function () {
      narr.rate = parseFloat(narrUI.rate.value) || 1;
      store("storyprints-help-rate", narrUI.rate.value === "1" ? null : narrUI.rate.value);
      restartLine();
    });

    loadVoices();
    if (synth.addEventListener) synth.addEventListener("voiceschanged", loadVoices);
    else synth.onvoiceschanged = loadVoices;
  }

  // a new voice or speed: say the current line again, in the new voice
  function restartLine() {
    if (!narr.on) return;
    stopSpeech();
    releaseHold();
  }

  // some browsers (Safari) only allow speech that starts from a click
  function unlockSpeech() {
    if (narr.unlocked || !narr.on || !synth) return;
    narr.unlocked = true;
    try { var u = new SpeechSynthesisUtterance(" "); u.volume = 0; synth.speak(u); } catch (e) { /* ignore */ }
  }

  // every scene starts paused at its beginning
  scenes.forEach(function (scene, i) {
    var svg = svgOf(i);
    try { svg.pauseAnimations(); } catch (e) { /* ignore */ }
    setTime(i, 0);
  });

  // the scene buttons
  var sceneButtons = scenes.map(function (scene, i) {
    var li = document.createElement("li");
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = (i + 1) + ". " + scene.getAttribute("data-title");
    b.addEventListener("click", function () { show(i, true); });
    li.appendChild(b);
    list.appendChild(li);
    return b;
  });

  function showCaption(i, t) {
    var beats = beatsOf(i);
    var text;
    if (reduce && !playing) {
      text = beats.map(function (b) { return b.text; }).join(" ");
    } else {
      text = beats.length ? beats[0].text : "";
      beats.forEach(function (b) { if (t + 0.01 >= b.at) text = b.text; });
    }
    var key = i + "|" + text;
    if (key !== lastBeat) {
      lastBeat = key;
      nameEl.textContent = "Scene " + (i + 1) + " of " + scenes.length + " · " + scenes[i].getAttribute("data-title");
      textEl.textContent = text;
    }
  }

  function update() {
    var t = Math.min(timeOf(current), durationOf(current));
    showCaption(current, t);
    seek.max = String(durationOf(current));
    seek.value = String(t);
    seek.setAttribute("aria-valuetext", fmt(t) + " of " + fmt(durationOf(current)));
    timeEl.textContent = fmt(t) + " / " + fmt(durationOf(current));
    playBtn.innerHTML = (playing ? ICON_PAUSE : ICON_PLAY) + "<span>" + (playing ? "Pause" : "Play") + "</span>";
    prevBtn.disabled = current === 0;
    nextBtn.disabled = current === scenes.length - 1;
    sceneButtons.forEach(function (b, i) { b.setAttribute("aria-current", i === current ? "true" : "false"); });
  }

  function tick() {
    var t = timeOf(current);
    if (narrate(Math.min(t, durationOf(current)))) {
      update();
      frame = requestAnimationFrame(tick);
      return;
    }
    if (t >= durationOf(current)) {
      if (current < scenes.length - 1) {
        show(current + 1, true);
        return;
      }
      pause();
      setTime(current, durationOf(current));
      update();
      return;
    }
    update();
    frame = requestAnimationFrame(tick);
  }

  function play() {
    unlockSpeech();
    if (!started) { started = true; overlay.hidden = true; }
    if (timeOf(current) >= durationOf(current) - 0.05) {
      if (current === scenes.length - 1 && !reduce) { show(0, true); return; }
      setTime(current, 0);
    }
    playing = true;
    try { svgOf(current).unpauseAnimations(); } catch (e) { /* ignore */ }
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(tick);
    update();
  }

  function pause() {
    playing = false;
    narr.holding = false;
    stopSpeech();
    cancelAnimationFrame(frame);
    try { svgOf(current).pauseAnimations(); } catch (e) { /* ignore */ }
    update();
  }

  function show(i, autoplay) {
    var wasPlaying = playing || autoplay;
    pause();
    scenes.forEach(function (scene, k) { scene.hidden = k !== i; });
    current = i;
    setTime(i, reduce && !autoplay ? durationOf(i) : 0);
    lastBeat = null;
    if (wasPlaying && (!reduce || autoplay)) play(); else update();
  }

  playBtn.addEventListener("click", function () { playing ? pause() : play(); });
  overlay.addEventListener("click", play);
  stage.addEventListener("click", function (e) {
    if (e.target.closest(".start-overlay")) return;
    playing ? pause() : play();
  });
  prevBtn.addEventListener("click", function () { if (current > 0) show(current - 1, playing); });
  nextBtn.addEventListener("click", function () { if (current < scenes.length - 1) show(current + 1, playing); });
  restartBtn.addEventListener("click", function () { show(0, true); });
  seek.addEventListener("input", function () {
    if (!started) { started = true; overlay.hidden = true; }
    stopSpeech();
    releaseHold();
    setTime(current, parseFloat(seek.value));
    if (!playing) {
      try { svgOf(current).pauseAnimations(); } catch (e) { /* ignore */ }
    }
    update();
  });

  // pause when the page is hidden, so it does not run on in a background tab
  document.addEventListener("visibilitychange", function () { if (document.hidden && playing) pause(); });

  window.addEventListener("pagehide", stopSpeech);
  buildNarrationUI();

  show(0, false);
  if (reduce) { overlay.hidden = true; started = true; }
})();
