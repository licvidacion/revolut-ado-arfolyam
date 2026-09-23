/* ============================================================================
 *  arfolyam-letolt.js — MNB hivatalos devizaárfolyamok → web/arfolyamok.js
 *  ---------------------------------------------------------------------------
 *  A `arfolyam-letolt.ps1` Node-os megfelelője. Ugyanazt a fájlt írja, ugyanabban
 *  a formátumban — csak nem kell hozzá PowerShell, tehát bármilyen gépen fut.
 *
 *  Futtatás:
 *    node eszkozok/arfolyam-letolt.js                    → 2015-01-01 .. ma
 *    node eszkozok/arfolyam-letolt.js 2015-01-01 2026-12-31
 *
 *  Miért fontos: az árfolyamtábla lejár. Ha egy ügylet napjára nincs jegyzés,
 *  a motor NEM számol nullával — hibát dob. Ez szándékos, de azt jelenti, hogy
 *  a táblát karban kell tartani.
 * ==========================================================================*/
'use strict';
var http = require('http');
var fs = require('fs');
var path = require('path');

var GYOKER = path.join(__dirname, '..');
var KIMENET = path.join(GYOKER, 'web', 'arfolyamok.js');

var DEVIZAK = 'USD,EUR,GBP,CHF,PLN,CZK,SEK,DKK,NOK,CAD,JPY';
var KEZDET = process.argv[2] || '2015-01-01';
var VEG = process.argv[3] || new Date().toISOString().slice(0, 10);

var soap =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">\n' +
  '  <soap:Body>\n' +
  '    <GetExchangeRates xmlns="http://www.mnb.hu/webservices/">\n' +
  '      <startDate>' + KEZDET + '</startDate>\n' +
  '      <endDate>' + VEG + '</endDate>\n' +
  '      <currencyNames>' + DEVIZAK + '</currencyNames>\n' +
  '    </GetExchangeRates>\n' +
  '  </soap:Body>\n' +
  '</soap:Envelope>';

console.log('');
console.log('  MNB árfolyamok letöltése: ' + KEZDET + ' .. ' + VEG);
console.log('  (' + DEVIZAK + ')');

var keres = http.request({
  host: 'www.mnb.hu', path: '/arfolyamok.asmx', method: 'POST',
  headers: {
    'Content-Type': 'text/xml; charset=utf-8',
    'SOAPAction': 'http://www.mnb.hu/webservices/GetExchangeRates',
    'Content-Length': Buffer.byteLength(soap, 'utf8')
  }
}, function (v) {
  var d = '';
  v.setEncoding('utf8');
  v.on('data', function (c) { d += c; });
  v.on('end', function () {
    if (v.statusCode !== 200) {
      console.error('  [HIBA] Az MNB ' + v.statusCode + ' státusszal válaszolt.');
      console.error('         A meglévő tábla VÁLTOZATLAN marad — nem írunk felül hibás adattal.');
      process.exit(1);
    }
    try { feldolgoz(d); }
    catch (e) {
      console.error('  [HIBA] A válasz feldolgozása nem sikerült: ' + e.message);
      console.error('         A meglévő tábla VÁLTOZATLAN marad.');
      process.exit(1);
    }
  });
});
keres.on('error', function (e) {
  console.error('  [HIBA] Nem sikerült elérni az MNB szolgáltatását: ' + e.message);
  console.error('         A meglévő tábla VÁLTOZATLAN marad.');
  process.exit(1);
});
keres.write(soap, 'utf8');
keres.end();

function feldolgoz(valasz) {
  /* A SOAP-burok belsejében egy escape-elt XML áll — ki kell bontani. */
  var m = /<GetExchangeRatesResult>([\s\S]*?)<\/GetExchangeRatesResult>/.exec(valasz);
  if (!m) throw new Error('nincs GetExchangeRatesResult a válaszban');
  var belso = m[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

  var tabla = {}, db = 0;
  var napRe = /<Day\s+date="(\d{4}-\d\d-\d\d)"\s*>([\s\S]*?)<\/Day>/g;
  var napM;
  while ((napM = napRe.exec(belso)) !== null) {
    var nap = napM[1], torzs = napM[2];
    var rRe = /<Rate\s+unit="(\d+)"\s+curr="([A-Z]{3})"\s*>([^<]*)<\/Rate>/g;
    var rM;
    while ((rM = rRe.exec(torzs)) !== null) {
      var egyseg = parseFloat(rM[1]) || 1;
      var deviza = rM[2];
      var ertek = parseFloat(String(rM[3]).replace(',', '.'));
      if (!(ertek > 0)) continue;
      if (!tabla[deviza]) tabla[deviza] = {};
      tabla[deviza][nap] = Math.round((ertek / egyseg) * 1e6) / 1e6;
      db++;
    }
  }

  var devizak = Object.keys(tabla).sort();
  if (!devizak.length) throw new Error('egyetlen árfolyamsor sem jött vissza');
  console.log('  ' + db + ' árfolyam-adat feldolgozva, ' + devizak.length + ' devizában.');

  /* Épség-ellenőrzés: nem írjuk felül a meglévő táblát kevesebb adattal.
     Egy csonka válasz csendben tönkretenné a visszamenőleges reprodukálhatóságot. */
  var regi = null;
  try { regi = require(KIMENET); } catch (e) { regi = null; }
  if (regi) {
    var regiDb = 0;
    Object.keys(regi).forEach(function (d) { regiDb += Object.keys(regi[d]).length; });
    if (db < regiDb) {
      console.error('  [HIBA] A letöltött tábla KEVESEBB adatot tartalmaz, mint a meglévő ' +
                    '(' + db + ' < ' + regiDb + ').');
      console.error('         Ez csonka válaszra utal. A meglévő tábla VÁLTOZATLAN marad.');
      process.exit(1);
    }
  }

  var most = new Date();
  function ket(x) { return x < 10 ? '0' + x : '' + x; }
  var idobelyeg = most.getFullYear() + '-' + ket(most.getMonth() + 1) + '-' + ket(most.getDate()) +
                  ' ' + ket(most.getHours()) + ':' + ket(most.getMinutes());

  var ki = '/* MNB hivatalos devizaarfolyamok - GENERALT FAJL, ne szerkeszd kezzel!\n' +
           '   Forras: http://www.mnb.hu/arfolyamok.asmx (GetExchangeRates)\n' +
           '   Frissitve: ' + idobelyeg + '  |  ' + KEZDET + ' .. ' + VEG + ' */\n' +
           'var ARFOLYAMOK = {\n';
  devizak.forEach(function (d) {
    var napok = Object.keys(tabla[d]).sort().map(function (k) {
      return '"' + k + '":' + tabla[d][k];
    });
    ki += '  "' + d + '": {' + napok.join(',') + '},\n';
  });
  ki += '};\n';
  ki += 'var ARFOLYAM_META = {letoltve:"' + idobelyeg + '", forras:"MNB arfolyamok.asmx ' +
        'GetExchangeRates", tol:"' + KEZDET + '", ig:"' + VEG + '"};\n';
  ki += "if (typeof module === 'object' && module.exports) module.exports = ARFOLYAMOK;\n";

  fs.writeFileSync(KIMENET, ki, 'utf8');

  var utolso = Object.keys(tabla.USD || {}).sort().pop();
  console.log('  [KÉSZ] ' + KIMENET);
  console.log('         Utolsó jegyzési nap a táblában: ' + utolso);
}
