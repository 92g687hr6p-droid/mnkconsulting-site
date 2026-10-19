/* StoryPrints help: plays a chapter made of animated scenes.
 *
 * Each scene is a <figure class="scene" data-duration="15" data-title="...">
 * holding one <svg> whose animation is SVG SMIL (so each scene has its own
 * clock that can be paused, played and moved to any time) and a hidden
 * <ol class="beats"> of caption lines, each with data-at = the second it
 * starts. Scenes play one after another; captions follow the scene's clock.
 * With "reduce motion" on, each scene opens at its end with all its words.
 *
 * Read aloud (optional, off by default): each caption line is spoken as it
 * appears, by a recorded voice (narration/index.json beside the page, made
 * with _tools/make_narration.py) or by one of the browser's own voices. If a
 * line is still being spoken when the next one is due, the scene waits for
 * it. The visitor picks the voice and speed; the choice is remembered in this
 * browser only.
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
  // Two kinds of voice: recorded voices (narration/index.json beside the page,
  // one file per caption line, made with _tools/make_narration.py) and the
  // browser's own speech voices. Recorded voices come first and play from this
  // website only; a line with no recording is spoken by the browser if it can.
  var OFFER_BROWSER_VOICES = false;
  var synth = window.speechSynthesis;
  if (typeof SpeechSynthesisUtterance === "undefined") synth = null;
  var narr = { on: false, choices: [], choice: null, rate: 1, spoken: -1, speaking: false, holding: false, token: 0, unlocked: false };
  var rec = { voices: [], lines: {}, ext: ".mp3" };
  var audio = null;
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
  function choiceKey(c) { return c ? (c.kind === "rec" ? "rec:" + c.id : c.voice.voiceURI) : null; }
  function cleanLine(text) { return text.replace(/^[\s…]+|[\s…]+$/g, "").replace(/…/g, ", ").replace(/·/g, ","); }
  function lineKey(text) { return text.replace(/\s+/g, " ").trim(); }
  function recordingOf(text, c) {
    var id = rec.lines[lineKey(text)];
    return id && c && c.kind === "rec" ? "narration/" + c.id + "/" + id + rec.ext : null;
  }

  function loadVoices() {
    if (!narrUI) return;
    var choices = rec.voices.map(function (v) { return { kind: "rec", id: v.id, label: v.label }; });
    var web = [];
    if (synth && OFFER_BROWSER_VOICES) {
      var all = synth.getVoices() || [];
      web = all.filter(function (v) { return v.lang && /^en/i.test(v.lang); });
      web.sort(function (a, b) { return voiceRank(a) - voiceRank(b) || a.name.localeCompare(b.name); });
      if (!web.length) web = all.slice();
    }
    web.forEach(function (v) { choices.push({ kind: "web", voice: v }); });
    narr.choices = choices;
    if (!choices.length) return;
    narrUI.box.hidden = false;
    // the visitor's own choice if it is here, otherwise the first recorded voice
    var keep = stored("storyprints-help-voice");
    narrUI.voice.innerHTML = "";
    var group = function (label) {
      if (!rec.voices.length || !web.length) return narrUI.voice;
      var g = document.createElement("optgroup");
      g.label = label;
      narrUI.voice.appendChild(g);
      return g;
    };
    var recGroup = rec.voices.length ? group("Recorded for this guide") : null;
    var webGroup = web.length ? group("Your browser’s voices") : null;
    choices.forEach(function (c, i) {
      var o = document.createElement("option");
      o.value = String(i);
      if (c.kind === "rec") {
        o.textContent = c.label;
        recGroup.appendChild(o);
      } else {
        var v = c.voice;
        o.textContent = v.name.replace(/^Microsoft\s+/, "").replace(/\s*-\s*English.*$/, "") +
          " (" + v.lang + ")" + (v.localService ? "" : " · Online");
        webGroup.appendChild(o);
      }
    });
    var pick = 0;
    choices.forEach(function (c, i) { if (choiceKey(c) === keep) pick = i; });
    narrUI.voice.value = String(pick);
    narr.choice = choices[pick];
    showVoiceNote();
  }

  function showVoiceNote() {
    if (!narrUI) return;
    narrUI.note.hidden = !(narr.choice && narr.choice.kind === "web" && narr.choice.voice.localService === false);
    narrUI.credit.hidden = !(narr.choice && narr.choice.kind === "rec");
  }

  function loadRecordings() {
    if (!window.fetch) return;
    fetch("narration/index.json", { cache: "no-cache" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || data.format !== "storyprints-narration" || !data.voices || !data.voices.length) return;
        rec.voices = data.voices.filter(function (v) { return v && /^[\w-]+$/.test(v.id); });
        rec.lines = data.lines || {};
        if (/^\.(mp3|m4a|wav|ogg)$/.test(data.ext)) rec.ext = data.ext;
        loadVoices();
      })
      .catch(function () { /* no recordings: the browser's voices only */ });
  }

  function stopSpeech() {
    narr.token++;
    narr.speaking = false;
    narr.spoken = -1;
    if (synth) { try { synth.cancel(); } catch (e) { /* ignore */ } }
    if (audio) { try { audio.pause(); } catch (e) { /* ignore */ } }
  }

  function releaseHold() {
    if (!narr.holding) return;
    narr.holding = false;
    if (playing) { try { svgOf(current).unpauseAnimations(); } catch (e) { /* ignore */ } }
  }

  function speakLine(text) {
    var token = ++narr.token;
    var finished = function () {
      if (token !== narr.token) return;
      narr.speaking = false;
      releaseHold();
    };
    var c = narr.choice;
    var file = recordingOf(text, c);
    narr.speaking = true;
    if (file) {
      if (!audio) audio = new Audio();
      narr.deadline = Date.now() + 10000 + text.length * 120 / narr.rate;
      audio.onended = finished;
      audio.onerror = finished;
      audio.onloadedmetadata = function () {
        if (token === narr.token && isFinite(audio.duration)) narr.deadline = Date.now() + 3000 + audio.duration * 1000 / narr.rate;
      };
      audio.src = file;
      audio.playbackRate = narr.rate;
      try { audio.defaultPlaybackRate = narr.rate; audio.preservesPitch = true; } catch (e) { /* ignore */ }
      var p = audio.play();
      if (p && p.catch) p.catch(finished);
      preloadNext();
      return;
    }
    if (!synth) { finished(); return; }
    var u = new SpeechSynthesisUtterance(cleanLine(text));
    if (c && c.kind === "web") { u.voice = c.voice; u.lang = c.voice.lang; } else { u.lang = "en-GB"; }
    u.rate = narr.rate;
    u.onend = finished;
    u.onerror = finished;
    narr.deadline = Date.now() + 4000 + text.length * 120 / narr.rate;
    try { synth.speak(u); } catch (e) { narr.speaking = false; }
  }

  // ask for the next line's recording while this one plays
  var preloader = null;
  function preloadNext() {
    var beats = beatsOf(current);
    var next = beats[narr.spoken + 1] || (scenes[current + 1] ? beatsOf(current + 1)[0] : null);
    var file = next && recordingOf(next.text, narr.choice);
    if (!file) return;
    if (!preloader) { preloader = new Audio(); preloader.preload = "auto"; preloader.muted = true; }
    preloader.src = file;
    try { preloader.load(); } catch (e) { /* ignore */ }
  }

  // called on every frame while playing; returns true while the scene is held for speech
  function narrate(t) {
    if (!narr.on || !narr.choice) return false;
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
    var box = document.createElement("div");
    box.className = "narration";
    box.hidden = true;
    box.innerHTML =
      '<label class="read-aloud"><input type="checkbox"> Read aloud</label>' +
      '<label class="pick">Voice <select></select></label>' +
      '<label class="pick">Speed <select><option value="0.85">Slower</option><option value="1">Normal</option><option value="1.15">Faster</option></select></label>' +
      '<p class="voice-note" hidden>Online voice: your browser sends the captions to its maker (Microsoft or Google) to be spoken. Recorded voices, and voices without “Online”, work without sending anything.</p>' +
      '<p class="voice-note voice-credit" hidden>Recorded voices made with <a href="https://huggingface.co/hexgrad/Kokoro-82M" rel="noopener">Kokoro</a>, an open-source speech model (Apache 2.0 licence).</p>';
    var selects = box.querySelectorAll("select");
    narrUI = { box: box, toggle: box.querySelector("input"), voice: selects[0], rate: selects[1], note: box.querySelector(".voice-note"), credit: box.querySelector(".voice-credit") };
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
      narr.choice = narr.choices[parseInt(narrUI.voice.value, 10)] || null;
      store("storyprints-help-voice", choiceKey(narr.choice));
      showVoiceNote();
      restartLine();
    });
    narrUI.rate.addEventListener("change", function () {
      narr.rate = parseFloat(narrUI.rate.value) || 1;
      store("storyprints-help-rate", narrUI.rate.value === "1" ? null : narrUI.rate.value);
      restartLine();
    });

    loadVoices();
    loadRecordings();
    if (synth) {
      if (synth.addEventListener) synth.addEventListener("voiceschanged", loadVoices);
      else synth.onvoiceschanged = loadVoices;
    }
  }

  // a new voice or speed: say the current line again, in the new voice
  function restartLine() {
    if (!narr.on) return;
    stopSpeech();
    releaseHold();
  }

  // phones (Safari in particular) only allow sound that starts from a tap,
  // so the first Play or Read aloud tap starts both kinds of voice silently
  function silentWav() {
    var n = 2400, b = new ArrayBuffer(44 + n * 2), d = new DataView(b);
    var w = function (o, s) { for (var k = 0; k < s.length; k++) d.setUint8(o + k, s.charCodeAt(k)); };
    w(0, "RIFF"); d.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt "); d.setUint32(16, 16, true);
    d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, 24000, true); d.setUint32(28, 48000, true);
    d.setUint16(32, 2, true); d.setUint16(34, 16, true); w(36, "data"); d.setUint32(40, n * 2, true);
    return URL.createObjectURL(new Blob([b], { type: "audio/wav" }));
  }
  function unlockSpeech() {
    if (narr.unlocked || !narr.on) return;
    narr.unlocked = true;
    if (synth) { try { var u = new SpeechSynthesisUtterance(" "); u.volume = 0; synth.speak(u); } catch (e) { /* ignore */ } }
    try {
      if (!audio) audio = new Audio();
      if (!audio.src) { audio.src = silentWav(); var p = audio.play(); if (p && p.catch) p.catch(function () {}); }
    } catch (e) { /* ignore */ }
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
