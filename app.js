// Mulut Rive yang berbicara: teks -> suara (Web Speech API) + viseme (view model Rive).

// ============================================================================
//  PENGATURAN — ganti di sini saja
// ============================================================================
//  RIV_FILE      : path ke file .riv, relatif dari folder app/ (index.html).
//                  Contoh: "mayna_avatar.riv" atau "riv/mulut_lain.riv".
//  ARTBOARD      : nama artboard. Kalau tidak ada di file, dipakai artboard
//                  default / pertama.
//  STATE_MACHINE : nama state machine. Kalau tidak ada, dipakai yang pertama.
//  VIEW_MODEL    : nama view model yang berisi isTalking dan angka 0..21.
//
//  Buka Console browser (Cmd+Option+J): isi file .riv (artboard, state
//  machine, properti view model) dan apa yang akhirnya dipakai dicetak di sana.
//
//  Catatan: browser tidak mengizinkan membaca file dari file://, jadi buka
//  lewat server lokal:  cd app && python3 -m http.server 8000
//  lalu buka http://localhost:8000
// ============================================================================
const RIV_FILE = "mayna_avatar_23a.riv";
const ARTBOARD = "Main";
const STATE_MACHINE = "State Machine 1";
const VIEW_MODEL = "VM";
const GREETING_TRIGGER = "greetings";   // properti trigger yang dipicu tombol Greetings

(function () {
  "use strict";

  const V = window.Visemes;
  const N = 22;                 // viseme 0..21
  const LEAD = 0.05;            // mulut mendahului suara (detik)
  const TAU = 0.04;             // kehalusan perpindahan antar bentuk mulut (detik)

  const $ = (id) => document.getElementById(id);
  const ui = {
    canvas: $("mouth"), text: $("text"), speak: $("speak"), stop: $("stop"),
    voice: $("voice"), rate: $("rate"), rateOut: $("rateOut"),
    pitch: $("pitch"), pitchOut: $("pitchOut"), mute: $("mute"),
    status: $("status"), viseme: $("viseme"), samples: $("samples"),
    greet: $("greet"),
  };

  // ---- Rive -----------------------------------------------------------------

  let talking = null;           // properti boolean isTalking
  let weights = null;           // properti number "0".."21"

  // Cetak isi file .riv ke Console, untuk mencocokkan nama-nama di PENGATURAN.
  function logContents(r) {
    const c = r.contents;
    if (!c) return;
    console.group(`Contents of ${RIV_FILE}`);
    c.artboards.forEach((ab) => {
      console.log(`artboard "${ab.name}"  state machines:`, ab.stateMachines.map((s) => s.name));
    });
    const vm = r.viewModelByName(VIEW_MODEL);
    if (vm) console.log(`view model "${vm.name}" properties:`, vm.properties.map((p) => `${p.name} (${p.type})`));
    else console.log(`view model "${VIEW_MODEL}" not found in this file`);
    console.groupEnd();
  }

  // Pilih artboard + state machine yang benar-benar ada, lalu mulai ulang dengannya.
  function startScene(r) {
    const boards = r.contents.artboards;
    const board = boards.find((a) => a.name === ARTBOARD) || boards[0];
    if (!board) throw new Error("the .riv file has no artboard");
    const sm = board.stateMachines.find((s) => s.name === STATE_MACHINE) || board.stateMachines[0];
    console.log(`using: artboard "${board.name}", state machine "${sm ? sm.name : "(none)"}"`);
    r.reset({ artboard: board.name, stateMachine: sm ? sm.name : undefined, autoplay: true, autoBind: true });

    // Kalau artboard belum punya view model terpasang, ikat VIEW_MODEL secara manual.
    let vmi = r.viewModelInstance;
    if (!vmi || vmi.viewModelName !== VIEW_MODEL) {
      const vm = r.viewModelByName(VIEW_MODEL);
      const inst = vm && (vm.defaultInstance() || vm.instance());
      if (inst) {
        r.bindViewModelInstance(inst);
        vmi = inst;
      }
    }
    return vmi;
  }

  // Halaman bisa memilih cara karakter mengisi canvas lewat atribut <canvas>:
  //   data-fit="cover|contain|fitWidth|fitHeight"   (default contain)
  //   data-align="center|topCenter|bottomCenter"    (default center)
  //   data-focus="x0 y0 x1 y1"  area artboard (koordinat artboard) yang di-zoom
  //                             supaya memenuhi canvas, mis. kepala karakter.
  //   data-focus-y="0.45"       letak tengah area itu di canvas (0 = atas, 1 = bawah)
  const FIT = { contain: rive.Fit.Contain, cover: rive.Fit.Cover, fitWidth: rive.Fit.FitWidth, fitHeight: rive.Fit.FitHeight };
  const ALIGN = { center: rive.Alignment.Center, topCenter: rive.Alignment.TopCenter, bottomCenter: rive.Alignment.BottomCenter };
  // Dibaca ulang tiap kali, supaya halaman bisa mengganti data-focus (mis. full body / close up).
  function readFocus() {
    const f = (ui.canvas.dataset.focus || "").trim().split(/[\s,]+/).map(Number);
    return f.length === 4 && f.every(Number.isFinite) && f[2] > f[0] && f[3] > f[1] ? f : null;
  }

  // Ukuran gambar canvas mengikuti ukuran tampilnya (boleh tidak persegi, mis. layar HP).
  function fitCanvas(r) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(ui.canvas.clientWidth * dpr);
    const h = Math.round(ui.canvas.clientHeight * dpr);
    if (!w || !h) return;
    if (ui.canvas.width !== w || ui.canvas.height !== h) r.resizeDrawingSurfaceToCanvas();
    const focus = readFocus();
    if (focus) zoomToFocus(r, focus);
  }

  // Gambar artboard lebih besar dari canvas supaya area data-focus memenuhi layar.
  // Frame layout Rive = kotak tujuan artboard dalam piksel canvas.
  function zoomToFocus(r, focus) {
    if (!r.loaded || !r.artboard) return;
    const b = r.bounds;
    const aw = b.maxX - b.minX, ah = b.maxY - b.minY;
    if (!aw || !ah) return;
    const cw = ui.canvas.width, ch = ui.canvas.height;
    const [x0, y0, x1, y1] = focus;
    const fw = x1 - x0, fh = y1 - y0;
    const s = ui.canvas.dataset.fit === "cover" ? Math.max(cw / fw, ch / fh) : Math.min(cw / fw, ch / fh);
    const left = cw / 2 - ((x0 + x1) / 2 - b.minX) * s;
    const focusY = parseFloat(ui.canvas.dataset.focusY) || 0.5;
    const top = ch * focusY - ((y0 + y1) / 2 - b.minY) * s;
    r.layout = new rive.Layout({ fit: rive.Fit.Fill, minX: left, minY: top, maxX: left + aw * s, maxY: top + ah * s });
  }

  // Pemuatan pertama sengaja tanpa state machine (hanya untuk membaca isi file);
  // startScene() langsung memulai ulang dengan state machine yang benar.
  rive.Rive.suppressDeprecationWarnings = ["default-state-machine"];

  const riveInstance = new rive.Rive({
    src: RIV_FILE,
    canvas: ui.canvas,
    autoplay: false,
    layout: new rive.Layout({
      fit: FIT[ui.canvas.dataset.fit] || rive.Fit.Contain,
      alignment: ALIGN[ui.canvas.dataset.align] || rive.Alignment.Center,
    }),
    onLoad: () => {
      logContents(riveInstance);
      let vmi;
      try {
        vmi = startScene(riveInstance);
      } catch (e) {
        console.error(e);
        setStatus(`Could not display ${RIV_FILE}: ${e.message}`, true);
        return;
      }
      fitCanvas(riveInstance);
      window.addEventListener("resize", () => fitCanvas(riveInstance));
      if (window.ResizeObserver) new ResizeObserver(() => fitCanvas(riveInstance)).observe(ui.canvas);

      // Tombol Greetings: memicu properti trigger di view model.
      const greeting = vmi && vmi.trigger(GREETING_TRIGGER);
      if (greeting) {
        ui.greet.disabled = false;
        ui.greet.addEventListener("click", () => greeting.trigger());
      } else {
        console.warn(`view model "${VIEW_MODEL}" has no trigger "${GREETING_TRIGGER}"`);
        ui.greet.title = `Trigger "${GREETING_TRIGGER}" not found in the view model`;
      }

      talking = vmi && vmi.boolean("isTalking");
      weights = vmi ? Array.from({ length: N }, (_, i) => vmi.number(String(i))) : null;
      if (!talking || !weights || weights.some((w) => !w)) {
        talking = weights = null;
        setStatus(`${RIV_FILE} loaded, but its view model has no isTalking and 0–21 number properties, so the mouth can't move yet. See the Console for its property list.`, true);
        return;
      }
      ui.speak.disabled = false;
      setStatus("Ready. Type some text and press Speak.");
    },
    onLoadError: (e) => {
      console.error("Failed to load", RIV_FILE, e);
      logContents(riveInstance);
      setStatus(location.protocol === "file:"
        ? "This page was opened from file://, so the browser can't read the .riv file. Run: cd app && python3 -m http.server 8000, then open http://localhost:8000"
        : `Could not load ${RIV_FILE}. Check the file name, ARTBOARD and STATE_MACHINE at the top of app.js (see the Console).`, true);
    },
  });

  // ---- pemutaran viseme -------------------------------------------------------

  const mix = new Float64Array(N);   // bobot ternormalisasi, jumlahnya 1
  let play = null;                   // { timeline, clock, speed, startedAt, wordIdx, synced, free }
  let lastFrame = 0;
  let shown = -1;

  function writeWeights() {
    // BlendStateDirect menerapkan animasi berurutan (tiap animasi me-lerp hasil
    // sebelumnya), jadi bobot ternormalisasi n diubah ke m_i = n_i / (n_0+..+n_i)
    // supaya hasil akhirnya tepat sum(n_i * pose_i).
    let acc = 0;
    for (let i = 0; i < N; i++) {
      acc += mix[i];
      weights[i].value = acc > 1e-6 ? (mix[i] / acc) * 100 : 0;
    }
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (!play || !weights) return;

    play.clock += dt * play.speed;
    if (play.synced) {
      // suara memberi tahu batas tiap kata: jangan mendahului kata berikutnya
      const next = play.timeline.words[play.wordIdx + 1];
      play.clock = Math.min(play.clock, next ? next.t0 : play.timeline.total);
    }
    if (play.free && play.clock >= play.timeline.total + 0.1) return finish();

    const target = V.visemeAt(play.timeline, play.clock + LEAD);
    const k = 1 - Math.exp(-dt / TAU);
    for (let i = 0; i < N; i++) mix[i] += ((i === target ? 1 : 0) - mix[i]) * k;
    writeWeights();

    if (target !== shown) {
      shown = target;
      ui.viseme.textContent = `viseme ${target} · ${V.LABELS[target]}`;
    }
  }
  requestAnimationFrame(frame);

  function begin(timeline, free) {
    mix.fill(0);
    mix[0] = 1;
    writeWeights();
    talking.value = true;
    play = { timeline, clock: 0, speed: 1, startedAt: performance.now(), wordIdx: -1, synced: false, free };
    ui.stop.disabled = false;
  }

  function finish(message) {
    if (!play) return;
    play = null;
    shown = -1;
    talking.value = false;
    ui.stop.disabled = true;
    ui.viseme.textContent = "viseme 0 · silence";
    setStatus(message || "Done.");
  }

  // Event "boundary" dari mesin suara: kata di charIndex baru saja mulai diucapkan.
  function onBoundary(e) {
    if (!play || (e.name && e.name !== "word")) return;
    const words = play.timeline.words;
    let idx = -1;
    for (let i = 0; i < words.length && words[i].charIndex <= e.charIndex; i++) idx = i;
    if (idx < 0) return;

    const elapsed = (performance.now() - play.startedAt) / 1000;
    const at = words[idx].t0;
    if (at > 0.4 && elapsed > 0.4) {
      // sesuaikan kecepatan perkiraan dengan kecepatan suara yang sebenarnya
      const measured = Math.min(2, Math.max(0.5, at / elapsed));
      play.speed += (measured - play.speed) * 0.5;
    }
    play.clock = at;
    play.wordIdx = idx;
    play.synced = true;
  }

  // ---- suara ----------------------------------------------------------------

  const synth = window.speechSynthesis;
  let voices = [];
  let current = null;           // utterance yang sedang aktif

  function loadVoices() {
    if (!synth) return;
    const list = synth.getVoices();
    if (!list.length) return;
    const rank = (v) => (v.lang.startsWith("en") ? 0 : v.lang.startsWith("id") ? 1 : 2);
    voices = list.slice().sort((a, b) => rank(a) - rank(b) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
    const keep = ui.voice.value;
    ui.voice.innerHTML = "";
    voices.forEach((v, i) => {
      const o = document.createElement("option");
      o.value = v.voiceURI;
      o.textContent = `${v.name} (${v.lang})`;
      ui.voice.appendChild(o);
      if (v.voiceURI === keep) ui.voice.selectedIndex = i;
    });
  }

  function selectedVoice() {
    return voices.find((v) => v.voiceURI === ui.voice.value) || null;
  }

  function stop() {
    current = null;
    if (synth) synth.cancel();
    finish("Stopped.");
  }

  function speak() {
    const text = ui.text.value.trim();
    if (!text || !weights) return;
    stop();

    const voice = selectedVoice();
    const rate = parseFloat(ui.rate.value);
    const lang = voice && voice.lang.startsWith("id") ? "id" : "en";
    const timeline = V.buildTimeline(text, { lang, rate });
    if (!timeline.segments.length) return setStatus("Nothing to speak.", true);

    if (ui.mute.checked || !synth) {
      begin(timeline, true);
      return setStatus(synth ? "Speaking silently…" : "This browser has no speech voices; the mouth moves without sound.");
    }

    const u = new SpeechSynthesisUtterance(text);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = "en-US";
    u.rate = rate;
    u.pitch = parseFloat(ui.pitch.value);
    const mine = () => current === u;
    u.onstart = () => { if (mine()) { begin(timeline, false); setStatus("Speaking…"); } };
    u.onboundary = (e) => { if (mine()) onBoundary(e); };
    u.onend = () => { if (mine()) { current = null; finish(); } };
    u.onerror = (e) => {
      if (!mine()) return;
      current = null;
      finish(`Speech failed to play (${e.error}).`);
    };
    current = u;
    setStatus("Preparing voice…");
    synth.speak(u);
  }

  // ---- UI -------------------------------------------------------------------

  function setStatus(message, isError) {
    ui.status.textContent = message;
    ui.status.classList.toggle("error", !!isError);
  }

  const fmt = (x) => parseFloat(x).toFixed(1);
  ui.rate.addEventListener("input", () => { ui.rateOut.textContent = fmt(ui.rate.value) + "×"; });
  ui.pitch.addEventListener("input", () => { ui.pitchOut.textContent = fmt(ui.pitch.value); });
  ui.speak.addEventListener("click", speak);
  ui.stop.addEventListener("click", stop);
  ui.text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); speak(); }
  });
  ui.samples.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.dataset.text == null) return;
    ui.text.value = b.dataset.text;
    speak();
  });

  if (synth) {
    loadVoices();
    synth.addEventListener("voiceschanged", loadVoices);
    window.addEventListener("pagehide", () => synth.cancel());
  } else {
    ui.voice.disabled = true;
  }

  // refit(): panggil setelah mengubah data-focus / data-focus-y / ukuran canvas dari luar.
  window.mouthApp = { speak, stop, refit: () => fitCanvas(riveInstance), get state() { return play; } };
})();
