/* ============================================================================
 *  frissesseg.js — naprakész-e a feed? (önálló, a feed-repóhoz)
 *  ---------------------------------------------------------------------------
 *  Devizánként nézi az utolsó jegyzési napot. Ha valamelyik több munkanapja
 *  lemaradt, hibával áll le — a GitHub ilyenkor e-mailt küld a repó
 *  tulajdonosának. Ünnepek (pl. karácsony) miatt a tűrés 4 munkanap.
 *
 *  Futtatás: node eszkozok/frissesseg.js
 * ==========================================================================*/
'use strict';
var path = require('path');
var A = require(path.join(__dirname, '..', 'web', 'arfolyamok.js'));

var TURES = 4;
var ma = new Date().toISOString().slice(0, 10);

function munkanapok(tol) {
  var n = 0, d = new Date(tol + 'T00:00:00Z');
  for (;;) {
    d.setUTCDate(d.getUTCDate() + 1);
    var s = d.toISOString().slice(0, 10);
    if (s > ma) break;
    var h = d.getUTCDay();
    if (h !== 0 && h !== 6) n++;
  }
  return n;
}

var rossz = [];
Object.keys(A).sort().forEach(function (dev) {
  var utolso = Object.keys(A[dev]).sort().pop();
  var mn = munkanapok(utolso);
  console.log('  ' + dev + '  ' + utolso + '  (' + mn + ' munkanap)');
  if (mn > TURES) rossz.push(dev + ' ' + utolso);
});

if (rossz.length) {
  console.log('\n  [LEMARADT] ' + rossz.join(', '));
  process.exit(1);
}
console.log('\n  [OK] Minden deviza naprakész.');
