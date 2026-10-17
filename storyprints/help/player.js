/* StoryPrints help: plays a chapter made of animated scenes.
 *
 * Each scene is a <figure class="scene" data-duration="15" data-title="...">
 * holding one <svg> whose animation is SVG SMIL (so each scene has its own
 * clock that can be paused, played and moved to any time) and a hidden
 * <ol class="beats"> of caption lines, each with data-at = the second it
 * starts. Scenes play one after another; captions follow the scene's clock.
 * With "reduce motion" on, each scene opens at its end with all its words.
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
    setTime(current, parseFloat(seek.value));
    if (!playing) {
      try { svgOf(current).pauseAnimations(); } catch (e) { /* ignore */ }
    }
    update();
  });

  // pause when the page is hidden, so it does not run on in a background tab
  document.addEventListener("visibilitychange", function () { if (document.hidden && playing) pause(); });

  show(0, false);
  if (reduce) { overlay.hidden = true; started = true; }
})();
