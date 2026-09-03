// click-to-walk.js
// ---------------------------------------------------------------------------
// Workaround para o clique-andar do client WASM.
//
// Contexto: o pick de terreno do client (RenderTerrain -> SelectFlag ->
// CollisionPosition) não devolve nada no build WASM — o clique chega ao
// handler (win=0, cms=0, sel=-1) mas a caminhada nunca dispara, então o
// personagem nunca anda com o mouse. As pontes de caminhada do joystick
// (RequestWalkByScreenDelta, que usa ScreenToWorldRay + interseção com o
// plano na altura do herói) funcionam perfeitamente.
//
// Este script intercepta o clique esquerdo no canvas do jogo e o roteia pela
// MESMA ponte do joystick: converte o ponto do clique (referência 640x480)
// em delta de tela em relação ao herói e chama RequestWalkByScreenDelta.
//
// Guarda de segurança: se houver entidade (monstro/NPC/jogador) perto do
// alvo do clique, o script NÃO interfere — deixa o handler nativo tentar
// atacar/conversar (o object-pick do nativo pode funcionar mesmo com o
// terrain-pick quebrado).
// ---------------------------------------------------------------------------
(function () {
  'use strict';

  // Âncora do herói na tela (referência 640x480) = WorldToScreen(herói).
  // Calibrada empiricamente (15/08/2026): slope L medido por caminhadas reais
  // ((160,0)->(+2,+3) e (0,120)->(+2,-2) tiles) + pick absoluto do diag
  // (pick(480,240)=(32.5,87.3) com herói em (29,85)) => âncora (294,169).
  // (Os chutes antigos 320,400 / 320,240 deslocavam cliques e "levavam pro
  // lado oposto" perto das gaiolas.)
  // Ajuste fino no navegador: localStorage clickWalkAX/clickWalkAY.
  var HERO_ANCHOR_X = 294;
  var HERO_ANCHOR_Y = 169;
  try {
    var lsAX = parseFloat(localStorage.getItem('clickWalkAX'));
    var lsAY = parseFloat(localStorage.getItem('clickWalkAY'));
    if (isFinite(lsAX)) HERO_ANCHOR_X = lsAX;
    if (isFinite(lsAY)) HERO_ANCHOR_Y = lsAY;
  } catch (err) { /* sem localStorage */ }

  // Se houver entidade a menos de N tiles do alvo do clique, não rouba o clique.
  var ENTITY_GUARD_TILES = 1.5;

  function ready(fn) {
    var M = window.Module;
    if (M && typeof M.RequestWalkByScreenDelta === 'function') return fn();
    var t = setInterval(function () {
      var m = window.Module;
      if (m && typeof m.RequestWalkByScreenDelta === 'function') {
        clearInterval(t);
        fn();
      }
    }, 300);
  }

  ready(function () {
    var canvas = document.getElementById('canvas');
    if (!canvas) return;

    canvas.addEventListener('click', function (e) {
      var M = window.Module;
      if (!M || typeof M.RequestWalkByScreenDelta !== 'function') return;
      if (e.button !== 0 && e.which !== 1 && e.button !== undefined && e.button !== 0) return;
      if (e.target !== canvas) return;

      // Só anda com o herói vivo.
      var hero;
      try {
        hero = M.GetHeroSnapshot();
      } catch (err) {
        return;
      }
      if (!hero || !hero.isLive) return;

      var r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;

      var refX = (e.clientX - r.left) * (640 / r.width);
      var refY = (e.clientY - r.top) * (480 / r.height);
      var dx = Math.round(refX - HERO_ANCHOR_X);
      var dy = Math.round(refY - HERO_ANCHOR_Y);

      // Guarda: alvo do clique no mundo ≈ herói + M⁻¹(delta) e não interfere
      // se houver entidade selecionável perto (deixa o nativo atacar/falar).
      try {
        if (M.GetNearbyEntities) {
          var near = M.GetNearbyEntities();
          if (near && typeof near.size === 'function') {
            var tX = hero.posX + dx / 60 + dy / 30;
            var tY = hero.posY + dx / 60 - dy / 30;
            var n = near.size();
            for (var i = 0; i < n; i++) {
              var ent = near.get(i);
              if (!ent || ent.isHero || !ent.live) continue;
              var dist = Math.max(Math.abs(ent.posX - tX), Math.abs(ent.posY - tY));
              if (dist < ENTITY_GUARD_TILES) return;
            }
          }
        }
      } catch (err) { /* sem guarda em caso de erro */ }

      M.RequestWalkByScreenDelta(dx, dy);
    });
  });
})();
