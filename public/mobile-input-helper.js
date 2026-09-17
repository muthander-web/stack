// ============================================================
// Mobile Virtual Keyboard & Performance Helper for OpenMU Web Client
// ============================================================
(function () {
  "use strict";

  // 1. Mobile Virtual Keyboard Proxy
  var inputProxy = document.createElement("input");
  inputProxy.id = "mobile-text-proxy";
  inputProxy.type = "text";
  inputProxy.autocomplete = "off";
  inputProxy.autocorrect = "off";
  inputProxy.autocapitalize = "off";
  inputProxy.spellcheck = false;
  // Font size >= 16px prevents iOS Safari from auto-zooming
  inputProxy.style.cssText = "position:fixed; opacity:0; pointer-events:none; left:0; top:0; width:1px; height:1px; font-size:16px;";
  document.body.appendChild(inputProxy);

  var canvas = document.getElementById("canvas");

  function triggerVirtualKeyboard(e) {
    if (!canvas) return;
    // Focus proxy on touch or click
    if (window.innerWidth <= 1024 || 'ontouchstart' in window) {
      inputProxy.focus();
    }
  }

  if (canvas) {
    canvas.addEventListener("touchstart", triggerVirtualKeyboard, { passive: true });
    canvas.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "touch") {
        triggerVirtualKeyboard(e);
      }
    }, { passive: true });
  }

  // Forward input from virtual keyboard to canvas
  inputProxy.addEventListener("input", function (e) {
    var val = inputProxy.value;
    if (!val || !canvas) return;

    for (var i = 0; i < val.length; i++) {
      var ch = val[i];
      // Dispatch text input event for SDL
      var textEv = new CustomEvent("textInput", { detail: { data: ch } });
      canvas.dispatchEvent(textEv);

      // Also dispatch standard keydown/keypress/keyup sequence
      var charCode = ch.charCodeAt(0);
      var keyEvDown = new KeyboardEvent("keydown", { key: ch, charCode: charCode, keyCode: charCode, bubbles: true });
      var keyEvPress = new KeyboardEvent("keypress", { key: ch, charCode: charCode, keyCode: charCode, bubbles: true });
      var keyEvUp = new KeyboardEvent("keyup", { key: ch, charCode: charCode, keyCode: charCode, bubbles: true });

      canvas.dispatchEvent(keyEvDown);
      canvas.dispatchEvent(keyEvPress);
      canvas.dispatchEvent(keyEvUp);
    }
    inputProxy.value = "";
  });

  inputProxy.addEventListener("keydown", function (e) {
    if (!canvas) return;
    if (e.key === "Backspace" || e.keyCode === 8) {
      var bsDown = new KeyboardEvent("keydown", { key: "Backspace", keyCode: 8, which: 8, bubbles: true });
      var bsUp = new KeyboardEvent("keyup", { key: "Backspace", keyCode: 8, which: 8, bubbles: true });
      canvas.dispatchEvent(bsDown);
      canvas.dispatchEvent(bsUp);
    } else if (e.key === "Enter" || e.keyCode === 13) {
      var enterDown = new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, which: 13, bubbles: true });
      var enterUp = new KeyboardEvent("keyup", { key: "Enter", keyCode: 13, which: 13, bubbles: true });
      canvas.dispatchEvent(enterDown);
      canvas.dispatchEvent(enterUp);
      inputProxy.blur();
    }
  });

  console.log("[OpenMU] Mobile input and keyboard bridge initialized.");
})();
