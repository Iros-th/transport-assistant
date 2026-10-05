/* Live persontæller — in-browser COCO-SSD people counting.
 *
 * Standalone: reuses the same approach as the repo root app.js
 * (getUserMedia + cocoSsd.load + model.detect in a loop), but counts only
 * the 'person' class and maps the count onto the app's crowding model.
 *
 * Loaded from camera.html together with the pinned CDN builds of
 * @tensorflow/tfjs@3.11.0 and @tensorflow-models/coco-ssd@2.2.2.
 *
 * Nothing is stored or transmitted: frames are read from the <video> element
 * and analysed locally, and only the resulting count leaves the detector.
 */

(function () {
  "use strict";

  // --- Crowding thresholds: mirror core/occupancy.py (CrowdingThresholds) ---
  //   ratio < 0.50 -> LAV        (LOW)
  //   ratio < 0.75 -> MODERAT    (MODERATE)
  //   ratio < 0.90 -> HØJ        (HIGH)
  //   ratio >=0.90 -> MEGET HØJ  (VERY_HIGH)
  var CROWD = {
    LOW_MAX: 0.50,
    MODERATE_MAX: 0.75,
    HIGH_MAX: 0.90,
  };

  function crowdingLevel(ratio) {
    var r = ratio < 0 ? 0 : (ratio > 1 ? 1 : ratio); // clamp, like crowding_score_for_ratio
    if (r < CROWD.LOW_MAX) return "LAV";
    if (r < CROWD.MODERATE_MAX) return "MODERAT";
    if (r < CROWD.HIGH_MAX) return "HØJ";
    return "MEGET HØJ";
  }

  function levelColorVar(level) {
    switch (level) {
      case "LAV": return "--crowd-low";
      case "MODERAT": return "--crowd-mod";
      case "HØJ": return "--crowd-high";
      default: return "--crowd-vhigh";
    }
  }

  // --- DOM ---
  var els = {};
  function $(id) { return document.getElementById(id); }

  var model = null;
  var stream = null;
  var running = false;
  var rafId = null;

  // FPS bookkeeping
  var lastFrameTs = 0;
  var fpsEma = 0;

  // --- State transitions ---
  function showOnly(panel) {
    els.loadingPanel.hidden = panel !== "loading";
    els.errorPanel.hidden = panel !== "error";
    els.appPanel.hidden = panel !== "app";
  }

  function showError(title, msg, hint) {
    els.errorTitle.textContent = title;
    els.errorMsg.textContent = msg;
    els.errorHint.textContent = hint || "";
    showOnly("error");
  }

  // --- Capacity handling ---
  function currentCapacity() {
    var v = parseInt(els.capacityInput.value, 10);
    if (!isFinite(v) || v < 1) v = 1;
    return v;
  }

  // --- Rendering the count + crowding ---
  function render(count) {
    var cap = currentCapacity();
    var ratio = count / cap; // occupancy_ratio(passenger_count, estimated_capacity)
    var pct = Math.round(Math.min(ratio, 1) * 100);
    var level = crowdingLevel(ratio);

    els.countValue.textContent = String(count);
    els.capEcho.textContent = String(cap);
    els.ratioValue.textContent = pct + " %";
    els.crowdBar.style.width = pct + "%";
    els.crowdBar.style.backgroundColor = "var(" + levelColorVar(level) + ")";
    els.crowdLevel.textContent = level;
    els.crowdLevel.setAttribute("data-level", level);
  }

  function renderFps(dtMs) {
    if (dtMs > 0) {
      var inst = 1000 / dtMs;
      fpsEma = fpsEma === 0 ? inst : fpsEma * 0.8 + inst * 0.2;
      els.fpsReadout.textContent = "FPS: " + fpsEma.toFixed(1);
    }
  }

  // --- Draw boxes for detected persons on the overlay ---
  function drawBoxes(persons) {
    var video = els.video;
    var canvas = els.overlay;
    // Match canvas backing store to the video's intrinsic size so box
    // coordinates (in video pixels) line up with the drawn image.
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    var ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = Math.max(2, Math.round(canvas.width / 320));
    ctx.strokeStyle = "#1c56d6";
    ctx.fillStyle = "rgba(28, 86, 214, 0.85)";
    ctx.font = "600 " + Math.max(12, Math.round(canvas.width / 40)) + "px -apple-system, Segoe UI, sans-serif";
    ctx.textBaseline = "top";

    for (var i = 0; i < persons.length; i++) {
      var b = persons[i].bbox; // [x, y, width, height] in video pixels
      var x = b[0], y = b[1], w = b[2], h = b[3];
      ctx.strokeRect(x, y, w, h);
      var label = String(i + 1);
      var tw = ctx.measureText(label).width + 8;
      var th = Math.max(14, Math.round(canvas.width / 34));
      ctx.fillStyle = "rgba(28, 86, 214, 0.85)";
      ctx.fillRect(x, y, tw, th);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, x + 4, y + 2);
    }
  }

  // --- Detection loop (mirrors app.js: model.detect(video) each frame) ---
  async function detectLoop() {
    if (!running) return;
    try {
      var predictions = await model.detect(els.video);
      var persons = predictions.filter(function (p) { return p.class === "person"; });
      render(persons.length);
      drawBoxes(persons);
    } catch (err) {
      // Keep the loop alive on transient decode errors; report once if fatal.
      console.error("detect error", err);
    }

    var now = performance.now();
    if (lastFrameTs) renderFps(now - lastFrameTs);
    lastFrameTs = now;

    rafId = requestAnimationFrame(detectLoop);
  }

  // --- Start / stop camera ---
  async function startCamera() {
    if (running) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError(
        "Kamera ikke tilgængeligt",
        "Denne browser understøtter ikke kameraadgang (getUserMedia).",
        "Prøv en nyere browser, eller åbn siden via https / localhost."
      );
      return;
    }

    els.startBtn.disabled = true;
    els.stageHint.textContent = "Starter kamera…";

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
    } catch (err) {
      els.startBtn.disabled = false;
      if (err && (err.name === "NotAllowedError" || err.name === "SecurityError" || err.name === "PermissionDeniedError")) {
        showError(
          "Kameraadgang nægtet",
          "Du (eller browseren) afviste adgang til kameraet.",
          "Giv siden lov til at bruge kameraet, og tryk «Start kamera» igen. Bemærk: nogle browsere tillader kun kamera via https eller localhost, ikke fra file://."
        );
      } else if (err && (err.name === "NotFoundError" || err.name === "DevicesNotFoundError" || err.name === "OverconstrainedError")) {
        showError(
          "Intet kamera fundet",
          "Der blev ikke fundet noget kamera på enheden.",
          "Tilslut et webkamera, og prøv igen."
        );
      } else {
        showError("Kamerafejl", (err && err.message) ? err.message : "Ukendt fejl ved start af kamera.", "");
      }
      return;
    }

    els.video.srcObject = stream;
    try {
      await els.video.play();
    } catch (e) { /* autoplay is best-effort; muted+playsinline should allow it */ }

    els.stageHint.style.display = "none";
    els.stopBtn.disabled = false;
    els.startBtn.disabled = false;
    running = true;
    lastFrameTs = 0;
    fpsEma = 0;
    rafId = requestAnimationFrame(detectLoop);
  }

  function stopCamera() {
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
    els.video.srcObject = null;
    var ctx = els.overlay.getContext("2d");
    ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
    els.stageHint.style.display = "";
    els.stageHint.textContent = "Kamera stoppet. Tryk «Start kamera» for at fortsætte.";
    els.stopBtn.disabled = true;
    els.startBtn.disabled = false;
    els.fpsReadout.textContent = "FPS: —";
    render(0);
  }

  // --- Boot: load the model, then reveal the app ---
  async function boot() {
    els = {
      loadingPanel: $("loadingPanel"),
      errorPanel: $("errorPanel"),
      appPanel: $("appPanel"),
      errorTitle: $("errorTitle"),
      errorMsg: $("errorMsg"),
      errorHint: $("errorHint"),
      startBtn: $("startBtn"),
      stopBtn: $("stopBtn"),
      capacityInput: $("capacityInput"),
      fpsReadout: $("fpsReadout"),
      video: $("video"),
      overlay: $("overlay"),
      stageHint: $("stageHint"),
      countValue: $("countValue"),
      capEcho: $("capEcho"),
      ratioValue: $("ratioValue"),
      crowdBar: $("crowdBar"),
      crowdLevel: $("crowdLevel"),
    };

    els.startBtn.addEventListener("click", startCamera);
    els.stopBtn.addEventListener("click", stopCamera);
    els.capacityInput.addEventListener("input", function () {
      // Re-render with the current count using the new capacity.
      render(parseInt(els.countValue.textContent, 10) || 0);
    });

    if (typeof cocoSsd === "undefined" || typeof tf === "undefined") {
      showError(
        "Kunne ikke indlæse modellen",
        "TensorFlow.js eller COCO-SSD blev ikke hentet.",
        "Kontroller din internetforbindelse — bibliotekerne hentes fra et CDN ved åbning af siden."
      );
      return;
    }

    try {
      model = await cocoSsd.load();
    } catch (err) {
      showError(
        "Kunne ikke indlæse modellen",
        (err && err.message) ? err.message : "Ukendt fejl under indlæsning af COCO-SSD.",
        "Kontroller din internetforbindelse og prøv at genindlæse siden."
      );
      return;
    }

    render(0);
    showOnly("app");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
