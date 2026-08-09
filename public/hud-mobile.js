// ============================================================
// Mu Zord — HUD mobile (somente leitura)
// Primeira peça da UI mobile: mostra nome, level e barras de
// HP/MP no canto superior. NÃO tem joystick, inventário, modal
// de NPC, captura de toque nem qualquer controle de ação.
//
// Defensivo por construção: se Module.GetHeroSnapshot() ainda
// não existir (client WASM carregando) ou lançar erro, este
// script permanece inativo silenciosamente — nunca quebra o jogo.
// ============================================================
(function () {
  "use strict";

  var POLL_MS = 200; // 5x por segundo

  var hudEl = null;
  var nameEl = null;
  var levelEl = null;
  var hpFillEl = null;
  var mpFillEl = null;

  // ---------- criação do elemento (estilos inline mínimos) ----------
  function createHud() {
    hudEl = document.createElement("div");
    hudEl.id = "hud-mobile";
    hudEl.style.position = "fixed";
    hudEl.style.top = "10px";
    hudEl.style.left = "10px";
    hudEl.style.zIndex = "2147483647";
    hudEl.style.minWidth = "180px";
    hudEl.style.padding = "8px 10px";
    hudEl.style.background = "rgba(0, 0, 0, 0.7)";
    hudEl.style.border = "1px solid rgba(255, 255, 255, 0.25)";
    hudEl.style.borderRadius = "8px";
    hudEl.style.color = "#fff";
    hudEl.style.font = "12px/1.4 monospace";
    hudEl.style.pointerEvents = "none"; // nunca bloqueia cliques do jogo
    hudEl.style.userSelect = "none";
    hudEl.style.display = "none"; // só aparece quando houver snapshot real
    hudEl.style.boxSizing = "border-box";

    nameEl = document.createElement("div");
    nameEl.style.fontWeight = "bold";
    nameEl.style.marginBottom = "4px";

    levelEl = document.createElement("div");
    levelEl.style.marginBottom = "6px";
    levelEl.style.opacity = "0.9";

    hpFillEl = createBar("HP", "#3ddc55");
    mpFillEl = createBar("MP", "#3d7bdc");

    hudEl.appendChild(nameEl);
    hudEl.appendChild(levelEl);
    hudEl.appendChild(hpFillEl.barWrap);
    hudEl.appendChild(mpFillEl.barWrap);

    document.body.appendChild(hudEl);
  }

  function createBar(label, color) {
    var labelEl = document.createElement("div");
    labelEl.style.fontSize = "10px";
    labelEl.style.opacity = "0.8";
    labelEl.style.marginBottom = "2px";
    labelEl.textContent = label;

    var fill = document.createElement("div");
    fill.style.width = "0%";
    fill.style.height = "100%";
    fill.style.background = color;
    fill.style.transition = "width 0.15s linear";

    var track = document.createElement("div");
    track.style.background = "#222";
    track.style.borderRadius = "3px";
    track.style.height = "10px";
    track.style.overflow = "hidden";
    track.appendChild(fill);

    var barWrap = document.createElement("div");
    barWrap.style.marginBottom = "4px";
    barWrap.appendChild(labelEl);
    barWrap.appendChild(track);

    return { barWrap: barWrap, fill: fill };
  }

  // ---------- leitura / polling ----------
  function pct(value, max) {
    var v = Number(value);
    var m = Number(max);
    if (!isFinite(v) || !isFinite(m) || m <= 0) return 0;
    var p = (v / m) * 100;
    return Math.max(0, Math.min(100, p));
  }

  function getSnapshot() {
    var Module = window.Module;
    if (!Module || typeof Module.GetHeroSnapshot !== "function") {
      return null;
    }
    try {
      var snap = Module.GetHeroSnapshot();
      return snap && typeof snap === "object" ? snap : null;
    } catch (e) {
      return null; // nunca propaga erro do jogo
    }
  }

  function tick() {
    if (!hudEl) return;
    var snap = getSnapshot();
    if (!snap) return;

    // Só exibe o HUD quando o personagem está ativo no mundo.
    // Na tela de seleção de personagem (isLive === false) ele fica oculto.
    if (snap.isLive !== true) {
      hudEl.style.display = "none";
      return;
    }

    nameEl.textContent = String(snap.name || "-");
    levelEl.textContent = "Level " + Number(snap.level || 0);
    hpFillEl.fill.style.width = pct(snap.hp, snap.hpMax) + "%";
    mpFillEl.fill.style.width = pct(snap.mp, snap.mpMax) + "%";

    hudEl.style.display = "block";
  }

  // ---------- boot ----------
  function boot() {
    if (!document.body) {
      window.addEventListener("DOMContentLoaded", boot);
      return;
    }
    createHud();
    setInterval(tick, POLL_MS);
    tick();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
