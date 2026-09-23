/* ============================================================================
 *  teszt-arfolyam-xlsx.js — az MNB HTTPS-es XLSX-feldolgozó tesztjei
 *  ---------------------------------------------------------------------------
 *  MIÉRT SZINTETIKUS FÁJLON. Az MNB csak a felhasználó gépéről érhető el:
 *  a felhő-környezet és a Cowork-VM is ki van tiltva. Egy olyan tesztet, ami
 *  hálózatot igényel, sehol nem lehetne lefuttatni — vagyis soha nem futna.
 *
 *  Ezért itt a VALÓDI fájl szerkezetét építjük újra (ellenőrizve a böngészőben:
 *  egy „Árfolyamok" munkalap, 1. sor „Dátum/ISO" + ISO-kódok, 2. sor „Egység",
 *  3. sortól dátum-sorszám + értékek, üres cella ahol nincs jegyzés), és ezen
 *  a szerkezeten mérjük a feldolgozót. Amit ez NEM tud megfogni: ha az MNB
 *  megváltoztatja a fájl felépítését. Pont ezért dob a feldolgozó hangos hibát
 *  minden szerkezeti eltérésnél — és pont ezt a hangos hibát teszteljük lent.
 *
 *  Futtatás: node eszkozok/teszt-arfolyam-xlsx.js
 * ==========================================================================*/
'use strict';
var zlib = require('zlib');
var path = require('path');
var X = require(path.join(__dirname, 'arfolyam-letolt-xlsx.js'));

var db = 0, hiba = 0;
function ok(nev, kapott, vart) {
  db++;
  if (JSON.stringify(kapott) !== JSON.stringify(vart)) {
    hiba++;
    console.log('  ✗ ' + nev + '\n      kapott: ' + JSON.stringify(kapott) +
                '\n      várt:   ' + JSON.stringify(vart));
  } else console.log('  ✓ ' + nev);
}
function all(nev, felt, uzenet) {
  db++;
  if (felt) console.log('  ✓ ' + nev);
  else { hiba++; console.log('  ✗ ' + nev + (uzenet ? '\n      ' + uzenet : '')); }
}
function dob(nev, fn, mintaRe) {
  db++;
  try { fn(); hiba++; console.log('  ✗ ' + nev + '\n      nem dobott hibát'); }
  catch (e) {
    if (mintaRe && !mintaRe.test(e.message)) {
      hiba++;
      console.log('  ✗ ' + nev + '\n      más hibát dobott: ' + e.message);
    } else console.log('  ✓ ' + nev);
  }
}
function csoport(c) { console.log('\n' + c); }

/* ------------------------------------------------- minimál ZIP-/XLSX-építő */
function crc32(buf) {
  var t = crc32.t || (crc32.t = (function () {
    var tab = [];
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      tab[n] = c >>> 0;
    }
    return tab;
  })());
  var c = 0xFFFFFFFF;
  for (var i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function zipEpit(fajlok) {
  var helyi = [], kozponti = [], eltolas = 0;
  fajlok.forEach(function (f) {
    var nyers = Buffer.from(f.tartalom, 'utf8');
    var tomor = zlib.deflateRawSync(nyers);
    var nev = Buffer.from(f.nev, 'utf8');
    var c = crc32(nyers);

    var lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(c, 14); lh.writeUInt32LE(tomor.length, 18);
    lh.writeUInt32LE(nyers.length, 22); lh.writeUInt16LE(nev.length, 26);
    lh.writeUInt16LE(0, 28);
    helyi.push(lh, nev, tomor);

    var ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(c, 16); ch.writeUInt32LE(tomor.length, 20);
    ch.writeUInt32LE(nyers.length, 24); ch.writeUInt16LE(nev.length, 28);
    ch.writeUInt32LE(eltolas, 42);
    kozponti.push(ch, nev);

    eltolas += 30 + nev.length + tomor.length;
  });
  var helyiBuf = Buffer.concat(helyi);
  var kozpontiBuf = Buffer.concat(kozponti);
  var eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(fajlok.length, 8); eocd.writeUInt16LE(fajlok.length, 10);
  eocd.writeUInt32LE(kozpontiBuf.length, 12);
  eocd.writeUInt32LE(helyiBuf.length, 16);
  return Buffer.concat([helyiBuf, kozpontiBuf, eocd]);
}

function oszlop(i) { return X.oszlopNev(i); }

/**
 * A valódi MNB-fájl szerkezetét utánozza.
 * @param fejlec  ISO-kódok az A oszlop után
 * @param egysegek  ugyanannyi elem
 * @param sorok   [{ sorszam, ertekek: [..] }]  — '' = aznap nincs jegyzés
 * @param opciok  { fejA, egysegA }  a szándékosan elrontott szerkezethez
 */
function mnbXlsx(fejlec, egysegek, sorok, opciok) {
  opciok = opciok || {};
  var SZ = [];
  function s(sz) {
    var i = SZ.indexOf(sz); if (i < 0) { SZ.push(sz); i = SZ.length - 1; }
    return i;
  }
  var sorXml = [];
  function cellaSzoveg(o, r, sz) {
    return '<c r="' + o + r + '" s="0" t="s"><v>' + s(sz) + '</v></c>';
  }
  function cellaSzam(o, r, v) { return '<c r="' + o + r + '" s="2" ><v>' + v + '</v></c>'; }

  var f = [cellaSzoveg('A', 1, opciok.fejA === undefined ? 'Dátum/ISO' : opciok.fejA)];
  fejlec.forEach(function (d, i) { f.push(cellaSzoveg(oszlop(i + 1), 1, d)); });
  sorXml.push('<row r="1" >' + f.join('') + '</row>');

  var e = [cellaSzoveg('A', 2, opciok.egysegA === undefined ? 'Egység' : opciok.egysegA)];
  egysegek.forEach(function (u, i) { e.push(cellaSzam(oszlop(i + 1), 2, u)); });
  sorXml.push('<row r="2" >' + e.join('') + '</row>');

  sorok.forEach(function (sor, n) {
    var r = n + 3;
    var c = ['<c r="A' + r + '" s="1" ><v>' + sor.sorszam + '</v></c>'];
    sor.ertekek.forEach(function (v, i) {
      /* Az MNB a jegyzés nélküli napot ÜRES szövegcellaként írja ki — ez fontos:
         nem 0, hanem „nincs adat". Ha ezt 0-nak vennénk, a motor egy nem létező
         nulla árfolyammal számolna. */
      if (v === '') c.push(cellaSzoveg(oszlop(i + 1), r, ''));
      else c.push(cellaSzam(oszlop(i + 1), r, v));
    });
    sorXml.push('<row r="' + r + '" >' + c.join('') + '</row>');
  });

  var lap = '<?xml version="1.0"?><worksheet><sheetData>' + sorXml.join('') +
            '</sheetData></worksheet>';
  var ss = '<?xml version="1.0"?><sst count="' + SZ.length + '">' +
    SZ.map(function (x) {
      return '<si><t>' + String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</t></si>';
    }).join('') + '</sst>';

  return zipEpit([
    { nev: '[Content_Types].xml', tartalom: '<?xml version="1.0"?><Types/>' },
    { nev: 'xl/workbook.xml',
      tartalom: '<?xml version="1.0"?><workbook><sheets><sheet name="Árfolyamok" sheetId="1"/></sheets></workbook>' },
    { nev: 'xl/sharedStrings.xml', tartalom: ss },
    { nev: 'xl/worksheets/sheet1.xml', tartalom: lap }
  ]);
}

/* 2026-09-21 = 46286, 2026-09-22 = 46287 (a valódi fájl utolsó sora 46287 volt) */
var NAP = { '2026-09-21': 46286, '2026-09-22': 46287, '2015-01-02': 42006, '2014-12-31': 42004 };

/* ======================================================= alap feldolgozás */
csoport('arfolyam-letolt-xlsx.js — alap feldolgozás');
X.kezdetetAllit('2015-01-01');

var buf = mnbXlsx(
  ['EUR', 'USD', 'JPY', 'GBP', 'CHF', 'PLN', 'CZK', 'SEK', 'DKK', 'NOK', 'CAD'],
  [1, 1, 100, 1, 1, 1, 1, 1, 1, 1, 1],
  [
    { sorszam: NAP['2026-09-21'], ertekek: [400.5, 361.73, 245.12, 460, 384.62, 88, 14.86, 32, 53, 34, 261] },
    { sorszam: NAP['2026-09-22'], ertekek: [401.0, 362.00, 246.00, 461, 385.00, 88.5, 14.9, 32.1, 53.1, 34.1, 262] }
  ]);
var r = X.feldolgoz(buf);

ok('mind a 11 deviza megvan', Object.keys(r.tabla).sort().join(','),
   'CAD,CHF,CZK,DKK,EUR,GBP,JPY,NOK,PLN,SEK,USD');
ok('az adatpontok száma', r.db, 22);
ok('az utolsó nap', r.utolsoNap, '2026-09-22');
ok('az első nap', r.elsoNap, '2026-09-21');
ok('az USD árfolyam változatlanul kerül be', r.tabla.USD['2026-09-22'], 362);

/* A JPY az MNB-nél 100 egységre van jegyezve. Ha az „Egység" sort figyelmen
   kívül hagynánk, SZÁZSZOROS árfolyamot írnánk a táblába — és minden jenes
   ügylet adóalapja százszoros lenne. Ez a teszt pont ezt őrzi. */
csoport('arfolyam-letolt-xlsx.js — az „Egység" sor (JPY = 100)');
ok('a JPY 100-zal osztva kerül be', r.tabla.JPY['2026-09-21'], 2.4512);
all('és NEM a nyers 245.12', r.tabla.JPY['2026-09-21'] !== 245.12);

/* ============================================ hiányzó jegyzés ≠ nulla */
csoport('arfolyam-letolt-xlsx.js — a jegyzés nélküli nap kimarad, nem lesz 0');
var buf2 = mnbXlsx(
  ['EUR', 'USD', 'JPY', 'GBP', 'CHF', 'PLN', 'CZK', 'SEK', 'DKK', 'NOK', 'CAD'],
  [1, 1, 100, 1, 1, 1, 1, 1, 1, 1, 1],
  [
    { sorszam: NAP['2026-09-21'], ertekek: [400.5, '', 245.12, 460, 384.62, 88, 14.86, 32, 53, 34, 261] },
    { sorszam: NAP['2026-09-22'], ertekek: [401.0, 362.00, 246.00, 461, 385.00, 88.5, 14.9, 32.1, 53.1, 34.1, 262] }
  ]);
var r2 = X.feldolgoz(buf2);
all('a hiányzó USD-jegyzés NINCS a táblában', r2.tabla.USD['2026-09-21'] === undefined,
    'kapott: ' + r2.tabla.USD['2026-09-21']);
ok('a másnapi USD viszont megvan', r2.tabla.USD['2026-09-22'], 362);
ok('az adatpontok száma eggyel kevesebb', r2.db, 21);

/* ================================================== kezdőnap-szűrés */
csoport('arfolyam-letolt-xlsx.js — a kezdőnap előtti sorok kimaradnak');
var buf3 = mnbXlsx(
  ['EUR', 'USD', 'JPY', 'GBP', 'CHF', 'PLN', 'CZK', 'SEK', 'DKK', 'NOK', 'CAD'],
  [1, 1, 100, 1, 1, 1, 1, 1, 1, 1, 1],
  [
    { sorszam: NAP['2014-12-31'], ertekek: [300, 260, 200, 400, 300, 70, 11, 30, 40, 30, 220] },
    { sorszam: NAP['2015-01-02'], ertekek: [315, 262, 210, 405, 305, 72, 11.5, 31, 42, 31, 225] }
  ]);
var r3 = X.feldolgoz(buf3);
ok('csak a 2015-01-01 utáni nap maradt', r3.elsoNap, '2015-01-02');
ok('és csak annak az adatai', r3.db, 11);

/* ============================== szerkezeti változás → HANGOS hiba */
csoport('arfolyam-letolt-xlsx.js — az MNB szerkezetváltása nem csendes');
dob('más fejléc az A1-ben → hiba',
    function () {
      X.feldolgoz(mnbXlsx(['EUR'], [1],
        [{ sorszam: NAP['2026-09-22'], ertekek: [400] }], { fejA: 'Datum' }));
    }, /Dátum\/ISO/);
dob('hiányzó „Egység" sor → hiba',
    function () {
      X.feldolgoz(mnbXlsx(['EUR'], [1],
        [{ sorszam: NAP['2026-09-22'], ertekek: [400] }], { egysegA: 'valami más' }));
    }, /Egység/);
dob('hiányzó deviza → hiba, nem csonka tábla',
    function () {
      X.feldolgoz(mnbXlsx(['EUR', 'USD'], [1, 1],
        [{ sorszam: NAP['2026-09-22'], ertekek: [400, 360] }]));
    }, /hiányzó deviza/);
dob('nem ZIP → hiba',
    function () { X.feldolgoz(Buffer.from('ez nem egy xlsx fájl', 'utf8')); },
    /ZIP/);
dob('üres időszak → hiba, nem üres tábla',
    function () {
      X.kezdetetAllit('2099-01-01');
      try {
        X.feldolgoz(mnbXlsx(['EUR', 'USD', 'JPY', 'GBP', 'CHF', 'PLN', 'CZK', 'SEK', 'DKK', 'NOK', 'CAD'],
          [1, 1, 100, 1, 1, 1, 1, 1, 1, 1, 1],
          [{ sorszam: NAP['2026-09-22'], ertekek: [400, 360, 240, 460, 385, 88, 14, 32, 53, 34, 261] }]));
      } finally { X.kezdetetAllit('2015-01-01'); }
    }, /egyetlen árfolyamadat sem/);

/* ======================================== dátum-sorszám átváltás */
csoport('arfolyam-letolt-xlsx.js — Excel dátum-sorszám');
ok('46287 → 2026-09-22', X.excelNap(46287), '2026-09-22');
ok('42006 → 2015-01-02', X.excelNap(42006), '2015-01-02');
dob('értelmetlen sorszám → hiba', function () { X.excelNap(0); }, /dátum-sorszám/);

csoport('arfolyam-letolt-xlsx.js — oszlopnevek');
ok('0 → A', X.oszlopNev(0), 'A');
ok('25 → Z', X.oszlopNev(25), 'Z');
ok('26 → AA', X.oszlopNev(26), 'AA');
ok('75 → BX (a valódi fájl utolsó oszlopa)', X.oszlopNev(75), 'BX');

/* ============================================================ SZERZŐDÉS
   A letöltő ÁLTAL GYÁRTOTT feedet a kiadott appban futó ellenőrzőnek el kell
   fogadnia. Ez a kettő két külön fájl, két külön gépen fut (GitHub futtató,
   illetve a felhasználó böngészője) — ha a formátum elcsúszik, a felhasználó
   appja némán a régi táblával marad. Ezért nem feltételezzük az egyezést,
   hanem MÉRJÜK. */
csoport('arfolyam-letolt-xlsx.js → arfolyam-frissito.js — a feed szerződése');
var FR = require(path.join(__dirname, '..', 'web', 'arfolyam-frissito.js'));
X.kezdetetAllit('2015-01-01');

var DEV11 = ['EUR', 'USD', 'JPY', 'GBP', 'CHF', 'PLN', 'CZK', 'SEK', 'DKK', 'NOK', 'CAD'];
var EGY11 = [1, 1, 100, 1, 1, 1, 1, 1, 1, 1, 1];
var regiBuf = mnbXlsx(DEV11, EGY11, [
  { sorszam: NAP['2026-09-21'], ertekek: [400.5, 361.73, 245.12, 460, 384.62, 88, 14.86, 32, 53, 34, 261] }
]);
var ujBuf = mnbXlsx(DEV11, EGY11, [
  { sorszam: NAP['2026-09-21'], ertekek: [400.5, 361.73, 245.12, 460, 384.62, 88, 14.86, 32, 53, 34, 261] },
  { sorszam: NAP['2026-09-22'], ertekek: [401.0, 362.00, 246.00, 461, 385.00, 88.5, 14.9, 32.1, 53.1, 34.1, 262] }
]);
var beepitett = X.feldolgoz(regiBuf).tabla;          // ez van a telepítőben
var feedObj = X.feedObjektum(X.feldolgoz(ujBuf));     // ezt gyártja a futtató

var sz = FR.ervenyesit(feedObj, beepitett, { maiNap: '2026-09-23' });
all('a letöltő feedjét az app ellenőrzője ELFOGADJA', sz.ok === true,
    'hibák: ' + JSON.stringify(sz.hibak.map(function (h) { return h.kod; })));
ok('a formátum egyezik', feedObj.formatum, FR.FORMATUM);
all('a feed megjelöli az MNB-t forrásként', /mnb\.hu/.test(feedObj.forras));
ok('a jegyzési egység benne van (JPY=100)', feedObj.egysegek.JPY, 100);
ok('az átfedés a teljes régi tábla', sz.statisztika.atfedes, 11);

/* JSON-on át is: a feed valóban szerializálható és visszaolvasható. */
var korbe = JSON.parse(JSON.stringify(feedObj));
var sz2 = FR.ervenyesit(korbe, beepitett, { maiNap: '2026-09-23' });
all('JSON-ba és vissza szerializálva is érvényes', sz2.ok === true);
var egyesitve = FR.egyesit(korbe, beepitett);
ok('az egyesítés hozza az új napot', egyesitve.USD['2026-09-22'], 362);
ok('és megtartja a régit', egyesitve.USD['2026-09-21'], 361.73);
ok('a JPY egységgel osztva marad', egyesitve.JPY['2026-09-22'], 2.46);

console.log('\n' + (hiba ? '✗ ' + hiba + ' hibás / ' + db
                         : '✓ mind a ' + db + ' XLSX-teszt jó'));
process.exit(hiba ? 1 : 0);
