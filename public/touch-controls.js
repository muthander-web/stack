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
// PONTOS RESOLVIDOS / NÃO CONFIRMADOS (aproximações a validar em device real):
//   A) Walk: RESOLVIDO na ponte nova — sendWalk() usa RequestWalkTo
//      (WasmBindings.cpp), que replica o clique no chão nativo
//      (PathFinding2 + SendMove) e ANIMA a caminhada. O SendWalkRequest
//      direto movia o herói sem animação (deslizava).
//   B) Mapeamento ângulo do joystick -> direção MU: usa a tabela nativa
//      DirTable + DIR_OFFSET (ver sendWalk/angleToDir) — calibrável.
//   C) attackAnimation do SendHitRequest (0 = ataque básico) — aproximação.
//   D) Skill no botão de ataque: usa GetSelectedSkill() — se o jogador
//      selecionou uma skill no jogo, manda SendTargetedSkill; senão,
//      ataque normal SendHitRequest (espelha botão direito/esquerdo).
// ============================================================
(function () {
  "use strict";

  var SHOW_BELOW_WIDTH = 900; // heurística: só mostra em telas pequenas
  var WALK_INTERVAL_MS = 200; // 1 passo a cada 200ms enquanto arrastar
  var DEAD_ZONE = 0.18;       // ignora arrasto quase no centro (jitter)
  var STEP_COUNT = 1;         // 1 tile por pacote de walk
  var ATTACK_ANIMATION = 0;   // NÃO CONFIRMADO (C): 0 = ataque básico

  // Ritmo do hold-to-repeat do botão de ataque. O anti-cheat do servidor
  // (SpeedHackDetectPlugIn) usa um token bucket: minIntervalMs = max(60,
  // 450 - attackSpeed*1.2). Atacar mais rápido que isso drena os tokens e,
  // após MaxWarnings (3) avisos, o AutoBan grava Account.State = Banned no
  // banco — foi exatamente isso que bloqueou test0/test1/test2 (os 300ms
  // antigos ficavam ABAIXO do intervalo legítimo ~400ms de um personagem
  // de nível baixo). 600ms fica acima do intervalo legítimo mesmo com
  // attack speed alto, então o bucket nunca esvazia.
  var ATTACK_HOLD_INTERVAL_MS = 600;

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
  var stick = { mag: 0, angle: 0, dx: 0, dy: 0 }; // mag 0..1, angle rad, dx/dy offset CSS px
  var walkTimer = null;
  var activePointerId = null;

  // Suporte unificado a ponteiro (mouse/touch/caneta) + fallback touch:
  // no DevTools mobile mode SEM emulação de touch, os eventos de touch não
  // disparam — pointer events cobrem os dois casos nos browsers modernos.
  var HAS_POINTER = typeof window.PointerEvent !== "undefined";

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
  // Ângulo (rad) -> direção MU (0-7) + deltas de tile.
  //
  // O client nativo indexa o mundo por 8 direções com a tabela
  // DirTable[16] (WSclient.cpp): { -1,-1, 0,-1, 1,-1, 1,0, 1,1, 0,1, -1,1, -1,0 }
  //   dir 0=(-1,-1) NW   dir 1=(0,-1) N   dir 2=(1,-1) NE   dir 3=(1,0) E
  //   dir 4=(1,1) SE     dir 5=(0,1) S    dir 6=(-1,1) SW   dir 7=(-1,0) W
  // Câmera padrão do MU: norte do mapa = topo da tela. Então o joystick
  // "para cima" deve andar na direção 1 (0,-1), "direita" = 3 (1,0), etc.
  // DIR_OFFSET é o botão de calibração: se no device o movimento vier
  // girado (ex: cima anda pra direita), some/subtraia 1 aqui.
  // ------------------------------------------------------------------
  var DIR_DELTAS = [
    [-1, -1], [0, -1], [1, -1], [1, 0],
    [1, 1], [0, 1], [-1, 1], [-1, 0],
  ];
  var DIR_OFFSET = 0; // calibração (0 = cima=tela → norte do mapa)

  function angleToDir(thetaRad) {
    var deg = thetaRad * 180 / Math.PI; // 0=E, 90=N, -90=S
    var eighth = Math.round(deg / 45);
    var d = (3 - eighth + DIR_OFFSET) % 8; // E=3, N=1, W=7, S=5 (DirTable)
    return (d + 8) % 8;
  }

  // ------------------------------------------------------------------
  // Caminhada animada relativa à CÂMERA: usa a ponte
  // RequestWalkByScreenDelta (WasmBindings.cpp), que replica a projeção do
  // clique do mouse (ScreenToWorldRay → tile → PathFinding2 + SendMove).
  // Assim a direção do joystick fica SEMPRE correta (empurrou pra cima na
  // tela = anda pra cima na tela), independente da rotação da câmera —
  // resolve o bug do "joystick não anda pra frente" da versão anterior
  // (que chutava um delta fixo de tile no mapa).
  //
  // dx/dy são normalizados para ~45px em coordenadas de referência 640×480
  // (a magnitude só define o quão longe o target fica; a direção vem da
  // projeção nativa).
  // ------------------------------------------------------------------
  function sendWalk() {
    if (!dragging || stick.mag <= DEAD_ZONE) return;

    var cv = document.querySelector("canvas");
    var cssW = cv && cv.getBoundingClientRect ? cv.getBoundingClientRect().width : 640;
    var k = 640 / (cssW || 640); // escala CSS px -> referência 640×480

    var dx = stick.dx * k;
    var dy = stick.dy * k;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return;

    var scale = 45 / len;
    safeCall("RequestWalkByScreenDelta", Math.round(dx * scale), Math.round(dy * scale));
  }

  // ------------------------------------------------------------------
  // Normaliza o retorno de GetNearbyEntities() para um Array real.
  // O embind (register_vector) devolve um VectorEntity — NÃO é um Array
  // JS nativo (Array.isArray === false); ele tem .size() e .get(i).
  // Sem esta normalização o tryAttack abortava em `!Array.isArray(...)`
  // e o botão de atacar nunca disparava nada.
  // ------------------------------------------------------------------
  function toEntityArray(entities) {
    if (!entities) return null;
    if (Array.isArray(entities)) return entities;
    if (typeof entities.size === "function" && typeof entities.get === "function") {
      var out = [];
      var n = entities.size();
      for (var i = 0; i < n; i++) {
        out.push(entities.get(i));
      }
      return out;
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Feedback "Sem alvo" (toast pequeno que some sozinho) — sem isso, tocar
  // o botão sem monstro em alcance não dava NENHUM retorno e parecia que o
  // botão estava quebrado.
  // ------------------------------------------------------------------
  var toastEl = null;
  var toastTimer = null;
  function showToast(text) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.style.position = "fixed";
      toastEl.style.left = "50%";
      toastEl.style.top = "calc(38% + env(safe-area-inset-top, 0px))";
      toastEl.style.transform = "translateX(-50%)";
      toastEl.style.background = "rgba(0,0,0,0.75)";
      toastEl.style.color = "#fff";
      toastEl.style.padding = "8px 16px";
      toastEl.style.borderRadius = "20px";
      toastEl.style.font = "14px sans-serif";
      toastEl.style.zIndex = "2147483647";
      toastEl.style.pointerEvents = "none";
      toastEl.style.transition = "opacity 0.4s";
      toastEl.style.opacity = "0";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.opacity = "1";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.style.opacity = "0";
    }, 1200);
  }

  // ------------------------------------------------------------------
  // Ataque: mira a entidade viva não-heroi mais próxima do herói e
  // dispara o ataque com o key dela.
  //
  // Regra (espelha o mapeamento nativo):
  //   - Se o jogador tem uma SKILL selecionada no jogo (ex: clicou numa
  //     skill na barra de skills), o botão manda SendTargetedSkill(skill,
  //     key) — equivale ao BOTÃO DIREITO do mouse (SendRequestMagic →
  //     SendTargetedSkill(Type, Key) em ZzzInterface.cpp, onde Type =
  //     CharacterAttribute->Skill[Hero->CurrentSkill]).
  //   - Senão, ataque NORMAL via SendHitRequest — equivale ao BOTÃO
  //     ESQUERDO (Action() → SendHitRequest(key, AT_ATTACK1, dir)).
  //
  // GetSelectedSkill() é a ponte nova (WasmBindings.cpp) que retorna a
  // skill selecionada (0 = nenhuma). Aproximação aceita: o client nativo
  // também faz path-finding até o alvo antes de soltar a skill — aqui só
  // enviamos o pacote; se o alvo estiver fora de alcance o servidor
  // ignora (documentado — validar em device real).
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
    var list = toEntityArray(entities);
    if (!list) return;

    // Raio de ataque: 6 tiles (cobre corpo-a-corpo e arco). Se não houver
    // alvo nesse raio, avisa — em vez de falhar silenciosamente.
    var MAX_ATTACK_RANGE = 6;
    var best = null;
    var bestDist = Infinity;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || !e.live || e.isHero) continue;
      var dx = (e.posX | 0) - hx;
      var dy = (e.posY | 0) - hy;
      var d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
    if (!best || bestDist > MAX_ATTACK_RANGE * MAX_ATTACK_RANGE) {
      showToast("Sem alvo por perto");
      return false;
    }

    // Skill selecionada? (GetSelectedSkill | 0 é 0 se a ponte faltar).
    //   Com skill  -> RequestSkillByKey: replica o botão DIREITO do mouse
    //                 (ExecuteSkill nativo → anima o cast + envia o pacote).
    //   Sem skill  -> RequestAttackByKey: replica o clique ESQUERDO (anima o
    //                 swing + envia SendHitRequest).
    //
    // ⚠️ VERSÃO ANTERIOR (m6) enviava o pacote cru (SendTargetedSkill /
    //   SendHitRequest): o dano saía, mas o personagem NÃO ANIMAVA o ataque
    //   — parecia que "o botão não funciona". As pontes novas executam o
    //   fluxo nativo completo (seta TargetCharacter, vira pro alvo, toca a
    //   animação e envia), com guards de null no C++ para nunca trap.
    var skill = safeCall("GetSelectedSkill") | 0;
    if (skill > 0) {
      safeCall("RequestSkillByKey", best.key);
    } else {
      safeCall("RequestAttackByKey", best.key);
    }
    return true;
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
    // Safe-area: mantém o joystick acima da barra de gestos / notch em
    // paisagem (exige viewport-fit=cover no meta do index.html; sem isso
    // o env() retorna 0 e o fallback mantém o deslocamento atual).
    stickEl.style.left = "calc(20px + env(safe-area-inset-left, 0px))";
    stickEl.style.bottom = "calc(24px + env(safe-area-inset-bottom, 0px))";
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
    // Safe-area: idem joystick — o botão de ataque fica acima do home
    // indicator em paisagem.
    attackEl.style.right = "calc(22px + env(safe-area-inset-right, 0px))";
    attackEl.style.bottom = "calc(26px + env(safe-area-inset-bottom, 0px))";
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
  // Joystick — eventos de ponteiro (mouse/touch/caneta) com fallback
  // para touch. getPoint() extrai clientX/Y de qualquer dos dois tipos,
  // então o mesmo handler funciona em dispositivo real, DevTools mobile
  // (com ou sem emulação de touch) e desktop.
  // ------------------------------------------------------------------
  function getPoint(e) {
    if (typeof e.clientX === "number" && typeof e.clientY === "number") {
      return { x: e.clientX, y: e.clientY };
    }
    if (e.changedTouches && e.changedTouches[0]) {
      return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
    }
    if (e.touches && e.touches[0]) {
      return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    return null;
  }

  function onStickStart(e) {
    if (dragging) return;
    var p = getPoint(e);
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    activePointerId = (typeof e.pointerId === "number") ? e.pointerId : null;
    if (activePointerId !== null && stickEl.setPointerCapture) {
      try { stickEl.setPointerCapture(activePointerId); } catch (err) { /* noop */ }
    }
    updateKnob(p);
    // Um passo imediato + repetição a cada intervalo enquanto arrastar.
    sendWalk();
    walkTimer = setInterval(sendWalk, WALK_INTERVAL_MS);
  }

  function onStickMove(e) {
    if (!dragging) return;
    if (activePointerId !== null && typeof e.pointerId === "number" && e.pointerId !== activePointerId) return;
    var p = getPoint(e);
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    updateKnob(p);
  }

  function onStickEnd(e) {
    if (!dragging) return;
    if (activePointerId !== null && typeof e.pointerId === "number" && e.pointerId !== activePointerId) return;
    e.preventDefault();
    e.stopPropagation();
    stopDrag();
  }

  function stopDrag() {
    dragging = false;
    activePointerId = null;
    stick.mag = 0;
    stick.dx = 0;
    stick.dy = 0;
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
    stick.dx = ox; // offset do knob em CSS px (tela: X p/ direita, Y p/ baixo)
    stick.dy = oy;
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

  // Botão de ataque: toque único = 1 ataque; SEGURAR = ataca a cada
  // ATTACK_HOLD_INTERVAL_MS (600ms) no alvo mais próximo (repete). O ritmo
  // é propositalmente conservador para NUNCA disparar o anti-cheat de
  // speedhack do servidor (que bane a conta — ver constante acima).
  // Feedback visual imediato no toque.
  var attackTimer = null;
  var attackPointerId = null;

  function onAttackStart(e) {
    e.preventDefault();
    e.stopPropagation();
    attackPointerId = (typeof e.pointerId === "number") ? e.pointerId : null;

    // Pulso visual — o jogador vê que o toque registrou.
    attackEl.style.transform = "scale(0.88)";
    attackEl.style.transition = "transform 0.08s";
    setTimeout(function () {
      attackEl.style.transform = "scale(1)";
    }, 80);

    tryAttack();
    // Hold-to-repeat: continua atacando enquanto segurar.
    attackTimer = setInterval(tryAttack, ATTACK_HOLD_INTERVAL_MS);
  }

  function onAttackEnd(e) {
    if (attackPointerId !== null && typeof e.pointerId === "number" && e.pointerId !== attackPointerId) return;
    e.preventDefault();
    e.stopPropagation();
    attackPointerId = null;
    if (attackTimer) {
      clearInterval(attackTimer);
      attackTimer = null;
    }
  }

  // Registra um evento nos modos pointer e touch. Quando o browser suporta
  // Pointer Events, os listeners de touch ficam redundantes (o browser
  // dispara pointer para toque) — mas registrá-los é inofensivo: para o
  // mesmo gesto, apenas um tipo dispara de fato em cada browser.
  function addControlListeners(el, fn) {
    if (HAS_POINTER) {
      el.addEventListener("pointerdown", fn.start, { passive: false });
      el.addEventListener("pointermove", fn.move, { passive: false });
      el.addEventListener("pointerup", fn.end, { passive: false });
      el.addEventListener("pointercancel", fn.end, { passive: false });
    } else {
      el.addEventListener("touchstart", fn.start, { passive: false });
      el.addEventListener("touchmove", fn.move, { passive: false });
      el.addEventListener("touchend", fn.end, { passive: false });
      el.addEventListener("touchcancel", fn.end, { passive: false });
    }
  }

  // ------------------------------------------------------------------
  // Bloqueia vazamento de eventos compat para o jogo: o port WASM (SDL)
  // pode registrar listeners de touchstart/mousedown no document/canvas.
  // Se o toque no botão/joystick vazar, o jogo interpreta como clique no
  // chão naquela posição da tela e o personagem ANDA até lá (parece que o
  // botão de ataque "não funciona" — o boneco sai correndo). O pointerdown
  // já é stopPropagation'ado nos handlers próprios; aqui matamos também os
  // eventos compat (touch/mouse) que sobem do elemento.
  // ------------------------------------------------------------------
  function blockCompat(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  function hardenElement(el) {
    ["touchstart", "touchend", "touchmove", "touchcancel", "mousedown", "mouseup", "mousemove", "click"].forEach(function (type) {
      el.addEventListener(type, blockCompat, { passive: false });
    });
  }

  // ------------------------------------------------------------------
  // Inicialização.
  // ------------------------------------------------------------------
  function init() {
    createElements();
    hardenElement(stickEl);
    hardenElement(attackEl);

    addControlListeners(stickEl, {
      start: onStickStart,
      move: onStickMove,
      end: onStickEnd,
    });

    // Botão de ataque: pointerdown = atacar (+segurar repete), pointerup
    // encerra. Fallback touch para browsers sem PointerEvent.
    if (HAS_POINTER) {
      attackEl.addEventListener("pointerdown", onAttackStart, { passive: false });
      attackEl.addEventListener("pointerup", onAttackEnd, { passive: false });
      attackEl.addEventListener("pointercancel", onAttackEnd, { passive: false });
    } else {
      attackEl.addEventListener("touchstart", onAttackStart, { passive: false });
      attackEl.addEventListener("touchend", onAttackEnd, { passive: false });
      attackEl.addEventListener("touchcancel", onAttackEnd, { passive: false });
    }

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
