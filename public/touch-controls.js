// ============================================================
// Mu Zord — Touch Controls (joystick virtual + botão de ataque)
// Segunda peça da UI mobile, isolada e testável.
//
// - Joystick fixo no canto inferior esquerdo (arrastar = andar).
// - Botão de ataque circular no canto inferior direito.
// - Visíveis só em telas pequenas (heurística innerWidth < 900 —
//   pode precisar de ajuste fino depois).
// - JS puro, estilos inline mínimos, sem framework.
//
// SEGURANÇA POR CONSTRUÇÃO:
//   Toda chamada a Module.* passa por safeCall() (typeof check +
//   try/catch). Se o bridge não existir ou lançar, este script
//   permanece inativo — NUNCA quebra o jogo.
//
// PONTOS NÃO CONFIRMADOS (aproximações a validar em device real):
//   A) Encodificação de pathBits/lookingDirection do SendWalkRequest
//      (ver comentário detalhado em sendWalk()).
//   B) Mapeamento ângulo do joystick -> direção MU (0=N, 2=E, ...).
//   C) attackAnimation do SendHitRequest (0 = ataque básico).
// ============================================================
(function () {
  "use strict";

  var SHOW_BELOW_WIDTH = 900; // heurística: só mostra em telas pequenas
  var WALK_INTERVAL_MS = 200; // 1 passo a cada 200ms enquanto arrastar
  var DEAD_ZONE = 0.18;       // ignora arrasto quase no centro (jitter)
  var STEP_COUNT = 1;         // 1 tile por pacote de walk
  var ATTACK_ANIMATION = 0;   // NÃO CONFIRMADO (C): 0 = ataque básico

  // Geometria do joystick (usada para clamp do knob e magnitude).
  var BASE_R = 55;            // metade da base (110x110)
  var KNOB_R = 23;            // metade do knob (46x46)
  var KNOB_CENTER = 32;       // offset central do knob (110-46)/2
  var MAX_OFFSET = BASE_R - KNOB_R + 4; // ~36px de curso

  var root = null;
  var stickEl = null;
  var knobEl = null;
  var attackEl = null;

  var dragging = false;
  var stick = { mag: 0, angle: 0 }; // mag 0..1, angle rad (0 = leste, anti-horário)
  var walkTimer = null;

  // ------------------------------------------------------------------
  // Helper defensivo: chama Module[name] somente se existir e nunca
  // deixa exceção escapar para o loop do jogo.
  // ------------------------------------------------------------------
  function safeCall(name) {
    try {
      var M = (typeof Module !== "undefined") ? Module : null;
      if (M && typeof M[name] === "function") {
        return M[name].apply(M, Array.prototype.slice.call(arguments, 1));
      }
    } catch (err) {
      if (window.console && console.warn) {
        console.warn("[touch-controls] Module." + name + " falhou:", err);
      }
    }
    return undefined;
  }

  // ------------------------------------------------------------------
  // Ângulo (rad) -> direção MU (0-7). Direções do cliente MU Online:
  // 0=N, 1=NE, 2=E, 3=SE, 4=S, 5=SW, 6=W, 7=NW.
  // NÃO CONFIRMADO (B): validar se 0 é mesmo Norte no protocolo.
  // ------------------------------------------------------------------
  function angleToDir(thetaRad) {
    var deg = thetaRad * 180 / Math.PI; // 0=E, 90=N, -90=S
    var eighth = Math.round(deg / 45);
    var d = (2 - eighth) % 8;
    return (d + 8) % 8;
  }

  // ------------------------------------------------------------------
  // Envia um passo de movimento (1 tile) na direção do joystick.
  //
  // Assinatura do bridge: SendWalkRequest(handle, sourceX, sourceY,
  //   targetX, targetY, pathBits, lookingDirection)
  // Mapeamento (NÃO CONFIRMADO — A):
  //   sourceX/sourceY = tile atual do herói (GetHeroSnapshot.posX/Y);
  //   targetX         = STEP_COUNT (nº de passos, nibble do pacote C1 D4);
  //   targetY         = direção final (rotation, nibble alto do pacote);
  //   pathBits        = direção do passo — aproximação do byte que o
  //                     array "directions" carrega por passo no pacote;
  //   lookingDirection= mesma direção (facing).
  //
  // ⚠️ DESCOBERTA NA AUDITORIA: o bridge C++ (WasmBindings.cpp ~L206-228)
  //   chama o símbolo WasmSendWalkRequest passando pathBits (int) onde o
  //   nativo espera `const uint8_t* directions` — incompatibilidade de
  //   tipos que faz o memcpy ler endereço inválido (trap do wasm). HOJE o
  //   movimento via esta chamada provavelmente NÃO funciona: a exceção é
  //   engolida pelo safeCall (o jogo continua, o personagem não anda).
  //   Este código já fica pronto para a correção da ponte — quando ela
  //   aceitar a direção do passo corretamente, nada muda no JS.
  // ------------------------------------------------------------------
  function sendWalk() {
    if (!dragging || stick.mag <= DEAD_ZONE) return;

    var snap = safeCall("GetHeroSnapshot");
    if (!snap || !snap.isLive) return;

    var hx = snap.posX | 0;
    var hy = snap.posY | 0;
    var dir = angleToDir(stick.angle);

    // handle=1 (EnsureValidHandle aceita; -1/0 viram 1).
    safeCall("SendWalkRequest", 1, hx, hy, STEP_COUNT, dir, dir, dir);
  }

  // ------------------------------------------------------------------
  // Ataque: mira a entidade viva não-heroi mais próxima do herói e
  // dispara SendHitRequest com o key dela.
  //
  // Distância: euclidiana em TILES (entity.posX/posY vs tile do herói
  // via GetHeroSnapshot) — unidades consistentes. O DTO também expõe
  // worldX/worldY (float, unidades de mundo) para uso futuro, mas o
  // snapshot do herói não traz world coords, então tile é a métrica
  // coerente hoje (documentado — NÃO confirmado).
  // ------------------------------------------------------------------
  function tryAttack() {
    var snap = safeCall("GetHeroSnapshot");
    if (!snap || !snap.isLive) return;

    var hx = snap.posX | 0;
    var hy = snap.posY | 0;

    var entities = safeCall("GetNearbyEntities");
    if (!Array.isArray(entities)) return;

    var best = null;
    var bestDist = Infinity;
    for (var i = 0; i < entities.length; i++) {
      var e = entities[i];
      if (!e || !e.live || e.isHero) continue;
      var dx = (e.posX | 0) - hx;
      var dy = (e.posY | 0) - hy;
      var d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
    if (!best) return;

    // Direção herói -> alvo (reusa o mapeamento 0-7; aproximação).
    var dir = 0;
    if (!(hx === (best.posX | 0) && hy === (best.posY | 0))) {
      dir = angleToDir(
        Math.atan2(-((best.posY | 0) - hy), (best.posX | 0) - hx),
      );
    }

    safeCall("SendHitRequest", 1, best.key, ATTACK_ANIMATION, dir);
  }

  // ------------------------------------------------------------------
  // Criação dos elementos (estilos inline mínimos).
  // ------------------------------------------------------------------
  function createElements() {
    root = document.createElement("div");
    root.id = "touch-controls";
    root.style.position = "fixed";
    root.style.inset = "0";
    root.style.zIndex = "2147483646";
    root.style.pointerEvents = "none"; // o container não bloqueia o jogo
    root.style.display = "none";
    root.style.userSelect = "none";

    // --- Joystick (base + knob) ---
    stickEl = document.createElement("div");
    stickEl.style.position = "fixed";
    stickEl.style.left = "20px";
    stickEl.style.bottom = "24px";
    stickEl.style.width = "110px";
    stickEl.style.height = "110px";
    stickEl.style.borderRadius = "50%";
    stickEl.style.background = "rgba(255,255,255,0.12)";
    stickEl.style.border = "2px solid rgba(255,255,255,0.35)";
    stickEl.style.boxSizing = "border-box";
    stickEl.style.pointerEvents = "auto"; // só o joystick captura toque
    stickEl.style.touchAction = "none";
    stickEl.style.boxShadow = "0 0 18px rgba(0,0,0,0.5)";

    knobEl = document.createElement("div");
    knobEl.style.position = "absolute";
    knobEl.style.width = "46px";
    knobEl.style.height = "46px";
    knobEl.style.borderRadius = "50%";
    knobEl.style.background = "rgba(255,255,255,0.55)";
    knobEl.style.border = "1px solid rgba(255,255,255,0.7)";
    knobEl.style.boxSizing = "border-box";
    knobEl.style.left = KNOB_CENTER + "px";
    knobEl.style.top = KNOB_CENTER + "px";
    knobEl.style.boxShadow = "0 0 10px rgba(0,0,0,0.4)";
    stickEl.appendChild(knobEl);

    // --- Botão de ataque (área de toque 72x72 ≥ 56x56 mínimos) ---
    attackEl = document.createElement("div");
    attackEl.style.position = "fixed";
    attackEl.style.right = "22px";
    attackEl.style.bottom = "26px";
    attackEl.style.width = "72px";
    attackEl.style.height = "72px";
    attackEl.style.borderRadius = "50%";
    attackEl.style.background = "rgba(200,30,30,0.55)";
    attackEl.style.border = "2px solid rgba(255,255,255,0.5)";
    attackEl.style.boxSizing = "border-box";
    attackEl.style.pointerEvents = "auto";
    attackEl.style.touchAction = "none";
    attackEl.style.color = "#fff";
    attackEl.style.font = "bold 22px/72px sans-serif";
    attackEl.style.textAlign = "center";
    attackEl.style.userSelect = "none";
    attackEl.style.boxShadow = "0 0 18px rgba(200,30,30,0.4)";
    attackEl.textContent = "⚔";
    attackEl.setAttribute("aria-label", "Atacar");

    root.appendChild(stickEl);
    root.appendChild(attackEl);
    document.body.appendChild(root);
  }

  // ------------------------------------------------------------------
  // Joystick — eventos de toque.
  // ------------------------------------------------------------------
  function onStickStart(e) {
    if (dragging) return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.changedTouches || !e.changedTouches[0]) return;
    var p = { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
    dragging = true;
    updateKnob(p);
    // Um passo imediato + repetição a cada intervalo enquanto arrastar.
    sendWalk();
    walkTimer = setInterval(sendWalk, WALK_INTERVAL_MS);
  }

  function onStickMove(e) {
    if (!dragging) return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.touches || !e.touches[0]) return;
    updateKnob({ x: e.touches[0].clientX, y: e.touches[0].clientY });
  }

  function onStickEnd(e) {
    if (!dragging) return;
    e.preventDefault();
    e.stopPropagation();
    stopDrag();
  }

  function stopDrag() {
    dragging = false;
    stick.mag = 0;
    stick.angle = 0;
    knobEl.style.left = KNOB_CENTER + "px";
    knobEl.style.top = KNOB_CENTER + "px";
    if (walkTimer) {
      clearInterval(walkTimer);
      walkTimer = null;
    }
  }

  function updateKnob(p) {
    var rect = stickEl.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var dx = p.x - cx;
    var dy = p.y - cy;
    var len = Math.sqrt(dx * dx + dy * dy);
    var clamped = Math.min(len, MAX_OFFSET);
    var ox = len > 0 ? dx * (clamped / len) : 0;
    var oy = len > 0 ? dy * (clamped / len) : 0;
    knobEl.style.left = (KNOB_CENTER + ox) + "px";
    knobEl.style.top = (KNOB_CENTER + oy) + "px";
    stick.mag = len > 0 ? clamped / MAX_OFFSET : 0;
    // 0 rad = leste (direita); "cima" da tela = norte (ângulo negativo de dy).
    stick.angle = Math.atan2(-dy, dx);
  }

  // ------------------------------------------------------------------
  // Visibilidade (heurística de tela pequena).
  // ------------------------------------------------------------------
  function updateVisibility() {
    if (!root) return;
    root.style.display = window.innerWidth < SHOW_BELOW_WIDTH ? "block" : "none";
  }

  // ------------------------------------------------------------------
  // Inicialização.
  // ------------------------------------------------------------------
  function init() {
    createElements();

    stickEl.addEventListener("touchstart", onStickStart, { passive: false });
    stickEl.addEventListener("touchmove", onStickMove, { passive: false });
    stickEl.addEventListener("touchend", onStickEnd, { passive: false });
    stickEl.addEventListener("touchcancel", onStickEnd, { passive: false });

    attackEl.addEventListener("touchstart", function (e) {
      e.preventDefault();
      e.stopPropagation();
      tryAttack();
    }, { passive: false });

    updateVisibility();
    window.addEventListener("resize", updateVisibility);
    window.addEventListener("orientationchange", updateVisibility);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
