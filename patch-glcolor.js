// Patch: make _emscripten_glColor4f inside glBegin/glEnd only update
// GLImmediate.clientColor instead of appending 4 bytes to the interleaved
// vertex buffer and incrementing vertexCounter.
//
// WHY: the emulator builds the interleaved buffer in CALL ORDER and derives
// the vertex stride from the first registration of each attribute. MU's UI
// code calls glColor* inside glBegin loops (RenderColorBitmap emits
// color/texcoord/vertex/color per vertex), so the extra color appends break
// the stride alignment -> garbage geometry -> black boxes on buttons, HUD
// icons, MuHelper window, etc. The custom flush already falls back to
// GLImmediate.clientColor whenever the COLOR attribute is not registered,
// so deferring the color there renders correctly with constant tinting.
const fs = require('fs');
const path = process.argv[2];
let src = fs.readFileSync(path, 'utf8');

const marker = 'var _emscripten_glColor4f=(r,g,b,a)=>{';
const start = src.indexOf(marker);
if (start === -1) { console.error('MARKER NOT FOUND in ' + path); process.exit(1); }

const endMarker = 'GLImmediate.clientColor[3]=a}};';
const end = src.indexOf(endMarker, start);
if (end === -1) { console.error('END MARKER NOT FOUND in ' + path); process.exit(1); }
const fullEnd = end + endMarker.length;

const oldFn = src.slice(start, fullEnd);
if (oldFn.indexOf('vertexCounter++') === -1) {
  console.error('UNEXPECTED: function body already changed? ' + oldFn.slice(0, 200));
  process.exit(1);
}
console.log('OLD FN (' + oldFn.length + ' chars):');
console.log(oldFn.slice(0, 400) + ' ...');

const newFn = 'var _emscripten_glColor4f=(r,g,b,a)=>{r=Math.max(Math.min(r,1),0);g=Math.max(Math.min(g,1),0);b=Math.max(Math.min(b,1),0);a=Math.max(Math.min(a,1),0);GLImmediate.clientColor[0]=r;GLImmediate.clientColor[1]=g;GLImmediate.clientColor[2]=b;GLImmediate.clientColor[3]=a;};';

src = src.slice(0, start) + newFn + src.slice(fullEnd);
fs.writeFileSync(path, src);
console.log('PATCHED OK -> ' + path);
