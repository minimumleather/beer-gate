/*
 * Beer Gate: covers the page until the visitor skulls a drink live on webcam.
 *
 * Add to any page with a script tag whose src is this file, or paste this whole file
 * inside a script tag. Get the code at https://minimumleather.github.io/beer-gate/code.html
 *
 * Optional settings (attributes on the script tag):
 *   data-max-seconds="25"   length of the chant; the drink must be upside down over
 *                           your head before it hits 1
 *   data-remember="true"    stay unlocked for the rest of the browser session
 *   data-title="..."        heading on the gate screen
 *   data-auto="false"       don't cover the page on load; call BeerGate.open() instead
 *                           (the gate then gets a close button, handy for demos)
 *
 * When unlocked it fires a "beergate:unlock" event on document
 * (event.detail.seconds is the skull time) and calls window.BeerGate.onUnlock if set.
 * BeerGate.reset() locks it again.
 *
 * Everything runs in the visitor's browser: video is never recorded or uploaded.
 * This is a novelty gate, not real security: anyone with dev tools can remove it.
 */
(() => {
  "use strict";

  const d = (document.currentScript && document.currentScript.dataset) || {};
  const num = (v, def) => (isFinite(parseFloat(v)) ? parseFloat(v) : def);
  const CFG = {
    maxSeconds: num(d.maxSeconds, 25),
    remember: d.remember !== "false",
    title: d.title || "Skull a beer to enter",
    auto: d.auto !== "false",
  };
  // Chant and drumroll are timed for a 25 second run and stretched to fit data-max-seconds.
  const K = CFG.maxSeconds / 25;

  const KEY = "beergate-unlocked";
  const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
  const MODELS = "https://storage.googleapis.com/mediapipe-models";
  const FACE_MODEL = `${MODELS}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`;
  const HAND_MODEL = `${MODELS}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`;
  const OBJ_MODEL = `${MODELS}/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite`;
  const VIRTUAL_CAM = /virtual|obs|manycam|xsplit|snap camera|camtwist|splitcam|e2esoft|youcam|vcam/i;

  // Random face-pulling checks so a pre-recorded clip fed through a fake camera can't pass.
  const CHALLENGES = [
    { text: "Open your mouth wide", test: (b) => b.jawOpen > 0.5 },
    { text: "Big cheesy smile", test: (b) => (b.mouthSmileLeft + b.mouthSmileRight) / 2 > 0.55 },
    { text: "Raise your eyebrows", test: (b) => b.browInnerUp > 0.5 },
    { text: "Turn your head to the side", test: (b, F) => F.turn > 0.22 },
    { text: "Pucker up (kissy face)", test: (b) => b.mouthPucker > 0.6 },
  ];

  // [seconds from the start of 3, 2, 1, line]. The 3, 2, 1 is always one second a line.
  const LYRICS = [
    [0, "3"], [1, "2"], [2, "1"],
    ...[
      [0, "We like to drink with this guy"],
      [3.75, "'Cause this guy is our mate"],
      [7.5, "And when we drink with this guy"],
      [11.25, "They get it down in..."],
      [15, "8"], [16.25, "7"], [17.5, "6"], [18.75, "5"],
      [20, "4"], [21.25, "3"], [22.5, "2"], [23.75, "1"],
    ].map(([at, text]) => [3 + at * K, text]),
  ];
  const lyricIndex = (sec) => {
    let i = 0;
    while (i + 1 < LYRICS.length && sec >= LYRICS[i + 1][0]) i++;
    return i;
  };

  window.BeerGate = window.BeerGate || {};
  window.BeerGate.reset = () => {
    try { sessionStorage.removeItem(KEY); } catch {}
    location.reload();
  };

  // ---------- Sound (synthesised live, so there are no audio files to host) ----------
  const Sound = (() => {
    let ac, out, timer, noiseBuf;

    const ctx = () => ac || (ac = new (window.AudioContext || window.webkitAudioContext)());

    // Quick attack, optional hold at full volume, then fade out by t + dur.
    function env(g, t, peak, attack, dur, hold = 0) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + attack);
      if (hold) g.gain.setValueAtTime(peak, t + hold);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    }
    function noise(t, dur, type, freq, q, peak, attack = 0.003, hold = 0) {
      if (!noiseBuf) {
        noiseBuf = ac.createBuffer(1, ac.sampleRate * 4, ac.sampleRate);
        const data = noiseBuf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      }
      const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
      s.buffer = noiseBuf;
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      env(g, t, peak, attack, dur, hold);
      s.connect(f); f.connect(g); g.connect(out);
      s.start(t, Math.random() * 0.4); s.stop(t + dur + 0.05);
    }
    function tone(t, dur, f0, f1, peak, type = "sine") {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      env(g, t, peak, 0.003, dur);
      o.connect(g); g.connect(out);
      o.start(t); o.stop(t + dur + 0.05);
    }

    const snare = (t, p) => { noise(t, 0.09, "highpass", 1500, 0.7, p); tone(t, 0.06, 240, 180, p * 0.35, "triangle"); };
    const tom = (t) => tone(t, 0.25, 220, 110, 0.6);

    // One voice in the crowd going "yaaay": a buzzy tone through two vowel formants,
    // pitch rising then settling, with a bit of wobble.
    function yay(t, f, dur) {
      const o = ac.createOscillator(), lfo = ac.createOscillator(), wob = ac.createGain(), g = ac.createGain();
      o.type = "sawtooth";
      o.frequency.setValueAtTime(f, t);
      o.frequency.linearRampToValueAtTime(f * 1.4, t + dur * 0.3);
      o.frequency.linearRampToValueAtTime(f * 1.1, t + dur);
      lfo.frequency.value = 5 + Math.random() * 2;
      wob.gain.value = f * 0.025;
      lfo.connect(wob); wob.connect(o.frequency);
      for (const [fq, q] of [[800, 5], [1700, 8]]) {
        const b = ac.createBiquadFilter();
        b.type = "bandpass"; b.frequency.value = fq; b.Q.value = q;
        o.connect(b); b.connect(g);
      }
      env(g, t, 0.35, 0.1, dur, dur * 0.6);
      g.connect(out);
      o.start(t); lfo.start(t);
      o.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
    }
    function crowd(t, len) {
      noise(t, len, "bandpass", 1000, 0.6, 0.25, 0.3, len * 0.65); // roar
      for (let i = 0; i < 8; i++) yay(t + Math.random() * 0.4, 180 + Math.random() * 220, 1.2 + Math.random() * 0.8);
      for (let i = 0; i < 5; i++) yay(t + 1.3 + Math.random() * 0.8, 200 + Math.random() * 200, 1 + Math.random() * 0.6);
      for (let i = 0; i < 90; i++) {                                // applause
        const c = t + 0.1 + Math.random() * (len - 0.6);
        noise(c, 0.04, "bandpass", 1000 + Math.random() * 1500, 1, 0.1 + Math.random() * 0.15, 0.001);
      }
    }
    // Air horn: short, short, long, each a three-note sawtooth chord that bends up into pitch.
    function airhorn(t) {
      for (const [at, len] of [[0, 0.22], [0.32, 0.22], [0.64, 1.1]]) {
        for (const f of [440, 554, 659]) {
          const o = ac.createOscillator(), lp = ac.createBiquadFilter(), g = ac.createGain();
          o.type = "sawtooth";
          o.frequency.setValueAtTime(f * 0.92, t + at);
          o.frequency.exponentialRampToValueAtTime(f, t + at + 0.05);
          lp.type = "lowpass"; lp.frequency.value = 2800;
          env(g, t + at, 0.12, 0.015, len, len - 0.06);
          o.connect(lp); lp.connect(g); g.connect(out);
          o.start(t + at); o.stop(t + at + len + 0.05);
        }
      }
    }
    function cheer(t) {
      airhorn(t);
      crowd(t + 0.5, 3.4);
    }

    function stop(fade = 0.08) {
      clearInterval(timer); timer = null;
      if (out) {
        const o = out;
        o.gain.setTargetAtTime(0, ac.currentTime, fade / 3);
        setTimeout(() => o.disconnect(), fade * 1000 + 300);
        out = null;
      }
    }

    // A snare roll that speeds up and gets louder through the chant,
    // with a tom hit on every number of the count.
    function drumroll() {
      stop();
      ctx().resume();
      out = ac.createGain();
      out.gain.value = 0.8;
      out.connect(ac.destination);
      const t0 = ac.currentTime + 0.05, L = 25 * K;
      let next = 0, numAt = 15, done = 0;
      const pump = () => {
        const until = ac.currentTime - t0 + 0.25;
        for (; next < until; next += 1 / (7 + 15 * Math.min(next / L, 1))) {
          const p = Math.min(next / L, 1);
          if (next >= done) snare(t0 + next, 0.08 + 0.4 * p * p + Math.random() * 0.04);
        }
        for (; numAt < 25 && numAt * K < until; numAt += 1.25) tom(t0 + numAt * K);
        done = until;
      };
      pump();
      timer = setInterval(pump, 60);
    }

    function celebrate() {
      clearInterval(timer); timer = null;
      if (!out) {
        ctx().resume();
        out = ac.createGain();
        out.gain.value = 0.8;
        out.connect(ac.destination);
      }
      const t = ac.currentTime + 0.02, o = out;
      cheer(t);
      setTimeout(() => { if (out === o) stop(0.5); }, 4500);
    }

    // Browsers only allow sound after a click, so this runs on the Start button.
    return { unlock: () => ctx().resume(), drumroll, celebrate, stop };
  })();

  let mounted = false;

  function mount() {
    if (mounted) return;
    mounted = true;

    // ---------- UI ----------
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap { position: fixed; inset: 0; overflow: auto; box-sizing: border-box; padding: 16px;
          display: flex; align-items: center; justify-content: center;
          background: radial-gradient(circle at 50% 0%, #3a2a0a, #120d05 70%);
          font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #fff7e6; }
        .card { width: 100%; max-width: 560px; text-align: center; margin: auto; }
        .card.live { max-width: 1000px; }
        h1 { font-size: 26px; margin: 0 0 8px; color: #ffc94a; }
        .intro { color: #e8d9b8; font-size: 15px; line-height: 1.5; margin: 0 0 18px; text-align: left; }
        .intro ol { margin: 8px 0 0; padding-left: 22px; }
        .main { display: grid; gap: 16px; align-items: center; }
        .stage { position: relative; width: 100%; aspect-ratio: 4 / 3; background: #000; border-radius: 14px;
          overflow: hidden; display: none; border: 2px solid #5a4214; }
        .card.live .stage { display: block; }
        video, canvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); }
        .lyrics { display: none; position: relative; height: 168px; overflow: hidden; text-align: left;
          -webkit-mask-image: linear-gradient(#000 65%, transparent); mask-image: linear-gradient(#000 65%, transparent); }
        .lyrics.on { display: block; }
        .track { transition: transform 0.35s ease; }
        .line { font-size: 30px; font-weight: 800; line-height: 1.2; padding: 6px 0; opacity: 0;
          transition: opacity 0.35s, color 0.35s; }
        .line.cur { opacity: 1; color: #ffc94a; }
        .line.n1 { opacity: 0.45; }
        .line.n2 { opacity: 0.18; }
        .msg { font-size: 22px; font-weight: 700; min-height: 1.3em; }
        .msg.win { font-size: 34px; color: #ffc94a; }
        .sub { color: #e8d9b8; min-height: 1.3em; margin: 4px 0 14px; font-size: 15px; font-variant-numeric: tabular-nums; }
        button { background: #ffc94a; color: #2a1c00; border: 0; border-radius: 999px; padding: 12px 28px;
          font-size: 16px; font-weight: 700; cursor: pointer; font-family: inherit; }
        button:hover { background: #ffd770; }
        button[hidden] { display: none; }
        .fine { margin-top: 16px; font-size: 12px; color: #a8977a; }
        .close { position: fixed; top: 12px; right: 12px; padding: 8px 16px; font-size: 14px;
          background: transparent; color: #e8d9b8; border: 1px solid #5a4214; }
        .close:hover { background: rgba(255, 201, 74, 0.13); border-color: #ffc94a; }
        @media (min-width: 760px) {
          .card.live .main { grid-template-columns: 1.4fr 1fr; }
          .card.live .side { text-align: left; }
        }
        @media (max-width: 480px) {
          .line { font-size: 24px; }
          .lyrics { height: 140px; }
        }
      </style>
      <div class="wrap"><button class="close" hidden>Close</button><div class="card">
        <h1></h1>
        <div class="intro">You'll need your webcam, your sound on, and a drink (bottles and glasses are easiest to spot).
          <ol>
            <li>Pull a couple of faces so we know you're live.</li>
            <li>Hold your drink out where the camera can see it.</li>
            <li>After 3, 2, 1 the chant starts. Skull it.</li>
            <li>Before the count hits 1, turn the empty upside down over your head.</li>
          </ol>
        </div>
        <div class="main">
          <div class="stage"><video playsinline muted></video><canvas></canvas></div>
          <div class="side">
            <div class="lyrics"><div class="track"></div></div>
            <div class="msg"></div>
            <div class="sub"></div>
            <button class="go">Start camera</button>
          </div>
        </div>
        <div class="fine">18+ only. Drink responsibly. Video stays on your device and is never recorded or uploaded.</div>
      </div></div>`;
    const $ = (s) => root.querySelector(s);
    $("h1").textContent = CFG.title;
    const card = $(".card"), video = $("video"), canvas = $("canvas"), ctx = canvas.getContext("2d");
    const msgEl = $(".msg"), subEl = $(".sub"), btn = $(".go"), lyricsEl = $(".lyrics"), trackEl = $(".track");

    const lineEls = LYRICS.map(([, text]) => {
      const el = document.createElement("div");
      el.className = "line";
      el.textContent = text;
      trackEl.appendChild(el);
      return el;
    });
    let lyricShown = -1;
    // Spotify-style: current line on top, the next two fading out below it.
    function showLyric(i) {
      lyricsEl.classList.toggle("on", i >= 0);
      if (i === lyricShown || i < 0) { lyricShown = i; return; }
      lyricShown = i;
      lineEls.forEach((el, j) => { el.className = "line" + (j === i ? " cur" : j === i + 1 ? " n1" : j === i + 2 ? " n2" : ""); });
      trackEl.style.transform = `translateY(${-lineEls[i].offsetTop}px)`;
    }

    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    (document.body || document.documentElement).appendChild(host);

    const say = (m, s = "") => { msgEl.textContent = m; subEl.textContent = s; msgEl.classList.remove("win"); };

    // ---------- Camera + models ----------
    let face, hand, obj, stream;

    async function makeTasks(vision) {
      const make = (delegate) => Promise.all([
        vision.FaceLandmarker.createFromOptions(vision.files, {
          baseOptions: { modelAssetPath: FACE_MODEL, delegate },
          runningMode: "VIDEO", numFaces: 1, outputFaceBlendshapes: true,
          // Lower than default so a bottle across the face doesn't drop tracking straight away.
          minFaceDetectionConfidence: 0.3, minFacePresenceConfidence: 0.3, minTrackingConfidence: 0.3,
        }),
        vision.HandLandmarker.createFromOptions(vision.files, {
          baseOptions: { modelAssetPath: HAND_MODEL, delegate },
          runningMode: "VIDEO", numHands: 2,
          minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.4,
        }),
        vision.ObjectDetector.createFromOptions(vision.files, {
          baseOptions: { modelAssetPath: OBJ_MODEL, delegate },
          runningMode: "VIDEO", scoreThreshold: 0.2, maxResults: 5,
          categoryAllowlist: ["bottle", "cup", "wine glass"],
        }),
      ]);
      try { return await make("GPU"); } catch { return await make("CPU"); }
    }

    async function start() {
      btn.hidden = true;
      Sound.unlock();
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        say("Camera unavailable", "This page has to be served over https for the webcam to work.");
        return;
      }
      say("Loading...", "Asking for your camera and warming up the beer detector.");
      try {
        const modelsP = import(`${MP}/vision_bundle.mjs`).then(async (m) => {
          const files = await m.FilesetResolver.forVisionTasks(`${MP}/wasm`);
          return makeTasks({ ...m, files });
        });
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false,
        });
        const label = stream.getVideoTracks()[0]?.label || "";
        if (VIRTUAL_CAM.test(label)) {
          stopCamera();
          say("Nice try", "Virtual cameras aren't allowed. Use a real webcam.");
          return;
        }
        video.srcObject = stream;
        await video.play();
        [face, hand, obj] = await modelsP;
      } catch (e) {
        stopCamera();
        const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
        say(denied ? "Camera blocked" : "Couldn't start", denied
          ? "Allow camera access in your browser, then try again."
          : "Something went wrong loading the camera or detector. Refresh and try again.");
        btn.textContent = "Try again";
        btn.hidden = false;
        return;
      }
      $(".intro").style.display = "none";
      card.classList.add("live");
      reset();
      requestAnimationFrame(loop);
    }

    function stopCamera() {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }

    // ---------- Per-frame tracking ----------
    let lastVT = -1, frameN = 0, running = true;
    let drink = null, lastDrinkSeen = 0, lastF = null, lastFaceT = 0, hands = [], lastHandsT = 0;

    function loop() {
      if (!running) return;
      requestAnimationFrame(loop);
      if (video.readyState < 2 || video.currentTime === lastVT) return;
      lastVT = video.currentTime;
      const now = performance.now();
      const W = video.videoWidth, H = video.videoHeight;
      if (canvas.width !== W) { canvas.width = W; canvas.height = H; }

      // F is the face seen this frame. G is where the face last was, which stands in
      // while the drink is covering it.
      const F = readFace(face.detectForVideo(video, now), W, H);
      if (F) { lastF = F; lastFaceT = now; }
      const G = F || lastF;

      // Hands and drinks take turns each frame to keep the frame rate up.
      if (frameN++ & 1) {
        hands = (hand.detectForVideo(video, now).landmarks || []).map((h) => h.map((p) => ({ x: p.x * W, y: p.y * H })));
        lastHandsT = now;
      } else {
        const boxes = (obj.detectForVideo(video, now).detections || []).map((x) => ({
          x: x.boundingBox.originX, y: x.boundingBox.originY, w: x.boundingBox.width, h: x.boundingBox.height,
        }));
        const pick = pickDrink(boxes, G, now);
        if (pick) { drink = pick; lastDrinkSeen = now; }
      }
      if (now - lastHandsT > 300) hands = [];
      // Detector flickers frame to frame, so a drink counts as present for a short while after it was last seen.
      const dr = now - lastDrinkSeen < 450 ? drink : null;

      const S = sense(now, F, G, dr);
      tick(now, F, G, dr, S);
      draw(G, dr, S);
    }

    const boxDist = (b, p) => Math.hypot(
      Math.max(b.x - p.x, 0, p.x - (b.x + b.w)),
      Math.max(b.y - p.y, 0, p.y - (b.y + b.h)),
    );
    const handDist = (p) => Math.min(Infinity, ...hands.flat().map((q) => Math.hypot(q.x - p.x, q.y - p.y)));
    const mid = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

    // The drink you're holding is the one in your hand, and it's close to the camera so
    // it's big next to your face. Drinks on a shelf behind you are neither. Once we've got
    // your drink, stick with whichever box is nearest to where it was last.
    function pickDrink(boxes, G, now) {
      let held = G ? boxes.filter((b) => Math.max(b.w, b.h) >= G.w * 0.4) : boxes;
      if (G && hands.length) {
        const inHand = held.filter((b) => hands.some((h) => h.some((p) => boxDist(b, p) < G.w * 0.4)));
        if (inHand.length) held = inHand;
      }
      if (!held.length) return null;
      if (drink && now - lastDrinkSeen < 1000) {
        const p = mid(drink);
        const dist = (b) => Math.hypot(mid(b).x - p.x, mid(b).y - p.y);
        return held.reduce((best, b) => (dist(b) < dist(best) ? b : best));
      }
      return held.reduce((best, b) => (b.w * b.h > best.w * best.h ? b : best));
    }

    function readFace(res, W, H) {
      const lm = res.faceLandmarks && res.faceLandmarks[0];
      if (!lm) return null;
      const P = (i) => ({ x: lm[i].x * W, y: lm[i].y * H });
      const top = P(10), l = P(234), r = P(454), up = P(13), lo = P(14), nose = P(1);
      const bs = {};
      (res.faceBlendshapes?.[0]?.categories || []).forEach((c) => { bs[c.categoryName] = c.score; });
      return {
        mouth: { x: (up.x + lo.x) / 2, y: (up.y + lo.y) / 2 },
        w: Math.hypot(r.x - l.x, r.y - l.y),
        top: top.y,
        // How far the nose sits off the middle of the face: 0 facing the camera, ~0.5 side on.
        turn: Math.abs((nose.x - l.x) / (r.x - l.x) - 0.5),
        bs,
      };
    }

    // Works out, for this frame, whether the drink is at your lips and whether it's over your head.
    let lastNearFaceT = 0;
    function sense(now, F, G, dr) {
      if (!G) return { atLips: false, overHead: false };
      if (dr && boxDist(dr, G.mouth) < G.w) lastNearFaceT = now;
      const recentDrink = now - lastDrinkSeen < 3000;
      // Any one of these counts as drinking:
      //  - the drink's box reaches your mouth
      //  - your hand is at your mouth and a drink was in view a moment ago
      //    (tipped up at the camera, a bottle is often too end-on to detect)
      //  - your face just vanished right after the drink was up near it
      const atLips = !!(
        (dr && boxDist(dr, G.mouth) < G.w * 0.5) ||
        (recentDrink && handDist(G.mouth) < G.w * 0.6) ||
        (!F && now - lastNearFaceT < 3000)
      );
      // Over your head: the drink itself is well above your forehead, or a hand is up there
      // and the drink was last seen on its way up. The margins stop a bottle tipped up
      // mid-skull (head back, so the forehead looks lower) from counting.
      const handUp = hands.some((h) => h.reduce((s, p) => s + p.y, 0) / h.length < G.top - G.w * 0.2);
      const drinkRaised = drink && now - lastDrinkSeen < 1500 && mid(drink).y < G.mouth.y;
      const overHead = !atLips && !!((dr && mid(dr).y < G.top - G.w * 0.4) || (handUp && drinkRaised));
      return { atLips, overHead };
    }

    function draw(G, dr, S) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const hot = S.atLips || S.overHead;
      if (dr) {
        ctx.lineWidth = 4;
        ctx.strokeStyle = hot ? "#4ade80" : "#ffc94a";
        ctx.strokeRect(dr.x, dr.y, dr.w, dr.h);
      }
      if (G) {
        ctx.fillStyle = S.atLips ? "#4ade80" : "#ffc94a";
        ctx.beginPath();
        ctx.arc(G.mouth.x, G.mouth.y, S.atLips ? 10 : 6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ---------- The skull state machine ----------
    let state, stateT, holdSince, challenges, liveIdx;
    let firstSipT, lastSipT, lipsUntil, result;

    function go(s) { state = s; stateT = performance.now(); holdSince = 0; }

    function reset() {
      btn.hidden = true;
      showLyric(-1);
      challenges = [...CHALLENGES].sort(() => Math.random() - 0.5).slice(0, 2);
      liveIdx = 0;
      lastFaceT = performance.now();
      go("findFace");
    }

    function fail(why) {
      go("fail");
      Sound.stop();
      showLyric(-1);
      say("Not good enough", why);
      btn.textContent = "Try again";
      btn.hidden = false;
    }

    // Holds a condition for ms before returning true once.
    function held(cond, now, ms) {
      if (!cond) { holdSince = 0; return false; }
      if (!holdSince) holdSince = now;
      return now - holdSince >= ms;
    }

    function tick(now, F, G, dr, S) {
      const t = now - stateT;
      // Before the countdown, the same face has to stay in shot.
      if ((state === "live" || state === "showDrink") && now - lastFaceT > 1500) {
        return fail("Lost sight of your face. Stay in frame.");
      }

      switch (state) {
        case "findFace":
          say("Get your face in the frame", "Good lighting helps. Keep your whole head in view.");
          if (held(!!F, now, 800)) go("live");
          break;

        case "live": {
          const c = challenges[liveIdx];
          say(c.text, `Live check ${liveIdx + 1} of ${challenges.length}`);
          if (held(F && c.test(F.bs, F), now, 400)) {
            liveIdx++;
            if (liveIdx < challenges.length) go("live"); else go("showDrink");
          } else if (t > 8000) fail("Too slow on the live check.");
          break;
        }

        case "showDrink":
          say("Hold your drink out in front of you", "Keep it away from your mouth for now.");
          if (held(G && dr && !S.atLips, now, 700)) go("countdown");
          else if (t > 20000) fail("Couldn't spot a drink. Try a bottle or glass in good light.");
          break;

        case "countdown":
          showLyric(lyricIndex(t / 1000));
          say("Get ready...", "Don't start until the chant does.");
          if (t >= 3000) {
            firstSipT = lastSipT = lipsUntil = 0;
            Sound.drumroll();
            go("skull");
          }
          break;

        case "skull": {
          // The chant runs on from the 3, 2, 1. The only way to fail is to reach the end of
          // it without the drink upside down over your head. Do that early and it's over.
          showLyric(lyricIndex(3 + t / 1000));
          if (S.atLips) {
            if (!firstSipT) firstSipT = now;
            lastSipT = now;
            lipsUntil = now + 500; // keeps the on-screen status steady through detector flicker
          }
          if (held(S.overHead, now, 600)) {
            // Skull time runs from first sip to last sip; if we never caught a sip, from the chant start.
            result = ((firstSipT ? lastSipT - firstSipT : t) / 1000) || t / 1000;
            return succeed();
          }
          if (t / 1000 > CFG.maxSeconds) return fail("No beer upside down over your head by the end of the count.");
          if (now < lipsUntil) say("Skull! Skull! Skull!", `Drinking ${((now - firstSipT) / 1000).toFixed(1)}s`);
          else if (firstSipT) say("Finished? Flip it over your head!", "Upside down, above your head.");
          else say("Get it to your lips!", "Skull it, then flip it over your head.");
          break;
        }
      }
    }

    function succeed() {
      go("done");
      running = false;
      stopCamera();
      showLyric(-1);
      Sound.celebrate();
      say("Congratulations, nice skull!", `Done in ${result.toFixed(1)} seconds.`);
      msgEl.classList.add("win");
      setTimeout(unlock, 4000);
    }

    function close() {
      running = false;
      stopCamera();
      host.remove();
      document.documentElement.style.overflow = prevOverflow;
      mounted = false;
    }

    function unlock() {
      try { if (CFG.remember) sessionStorage.setItem(KEY, "1"); } catch {}
      close();
      document.dispatchEvent(new CustomEvent("beergate:unlock", { detail: { seconds: result } }));
      if (typeof window.BeerGate.onUnlock === "function") window.BeerGate.onUnlock(result);
    }

    btn.addEventListener("click", () => {
      Sound.unlock();
      if (stream) reset(); else start();
    });

    // Opened on demand, so let people back out; a real gate has no way round it.
    if (!CFG.auto) {
      $(".close").hidden = false;
      $(".close").addEventListener("click", () => { Sound.stop(); close(); });
    }
  }

  window.BeerGate.open = mount;
  let unlocked = false;
  try { unlocked = CFG.remember && sessionStorage.getItem(KEY) === "1"; } catch {}
  if (CFG.auto && !unlocked) mount();
})();
