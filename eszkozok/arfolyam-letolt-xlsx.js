/* ============================================================================
 *  arfolyam-letolt-xlsx.js — MNB hivatalos árfolyamok az HTTPS-es XLSX-ből
 *  ---------------------------------------------------------------------------
 *  MIÉRT VAN EZ, HA MÁR VAN EGY LETÖLTŐ.
 *
 *  A meglévő `arfolyam-letolt.js` (és a `.ps1`) az MNB SOAP szolgáltatását
 *  hívja: `arfolyamok.asmx` / `GetExchangeRates`. Ez működik — de KIZÁRÓLAG
 *  sima HTTP-n. Böngészőben ellenőriztem: a `https://www.mnb.hu/arfolyamok.asmx`
 *  POST **404**-et ad (a `?wsdl` GET 200-at, a POST végpont viszont nincs
 *  HTTPS-en), és CORS-fejléc sincs. Ennek három következménye van:
 *
 *    1. Az appból (böngészőből) SOHA nem lesz lekérdezhető: egy https vagy
 *       file:// oldalról a sima HTTP kérést a böngésző vegyes tartalomként
 *       blokkolja. Ez nem CORS-kérdés, hanem protokoll-kérdés.
 *    2. Egyre több hálózat és futtatókörnyezet tiltja a sima HTTP-t.
 *    3. Nincs titkosítva — nyilvános adat, de a sértetlensége sem garantált.
 *
 *  Az MNB viszont közzéteszi a TELJES hivatalos árfolyam-idősort egyetlen
 *  XLSX fájlban, HTTPS-en:
 *
 *      https://www.mnb.hu/Root/ExchangeRate/arfolyam.xlsx
 *
 *  Ellenőrizve: egy munkalap („Árfolyamok"), 76 oszlop (ISO-kódok), 12 871 sor,
 *  1949-től a mai napig. Ugyanaz a hivatalos MNB-árfolyam, csak más csomagolásban.
 *
 *  EZ NEM HELYETTESÍTI A SOAP-OT, HANEM KIEGÉSZÍTI. Két független út ugyanahhoz
 *  a hivatalos adathoz: ha az egyik elérhetetlen vagy megváltozik, a másik még
 *  megy — és a kettő EGYMÁS ELLENŐRZÉSE is (`--ellenoriz`). Egy adószámolónál
 *  ez nem luxus: a rossz árfolyam csendben rossz adóalapot ad.
 *
 *  Függőségmentes: csak beépített Node-modulok (https, zlib, fs).
 *
 *  Futtatás:
 *    node eszkozok/arfolyam-letolt-xlsx.js                 → 2015-01-01 .. ma
 *    node eszkozok/arfolyam-letolt-xlsx.js 2010-01-01      → más kezdőnap
 *    node eszkozok/arfolyam-letolt-xlsx.js --ellenoriz     → NEM ír, csak összevet
 *    node eszkozok/arfolyam-letolt-xlsx.js --fajl=x.xlsx   → helyi fájlból (teszt)
 * ==========================================================================*/
'use strict';
var https = require('https');
var zlib = require('zlib');
var fs = require('fs');
var path = require('path');

var GYOKER = path.join(__dirname, '..');
var KIMENET = path.join(GYOKER, 'web', 'arfolyamok.js');
/* A kiadott apphoz szánt, nyilvános JSON feed. Ugyanaz az adat, JSON-ként. */
var FEED = path.join(GYOKER, 'web', 'arfolyamok.json');
var FORRAS = 'https://www.mnb.hu/Root/ExchangeRate/arfolyam.xlsx';

/* Ugyanaz a devizakör, mint a SOAP-letöltőben — hogy a két forrás
   összevethető maradjon. */
var DEVIZAK = 'USD,EUR,GBP,CHF,PLN,CZK,SEK,DKK,NOK,CAD,JPY'.split(',');

var argv = process.argv.slice(2);
var ELLENORIZ = argv.indexOf('--ellenoriz') >= 0;
var HELYI = null;
argv.forEach(function (a) {
  var m = /^--fajl=(.+)$/.exec(a); if (m) HELYI = m[1];
});
var KEZDET = argv.filter(function (a) { return /^\d{4}-\d\d-\d\d$/.test(a); })[0] || '2015-01-01';

/* ==========================================================================
 *  1. ZIP — annyi, amennyi egy XLSX-hez kell
 * ========================================================================
 *  Az XLSX egy ZIP. A központi katalógusból (central directory) kiolvassuk a
 *  bejegyzéseket, és a kettőből (tárolt / deflate) kibontjuk a kellő fájlokat.
 *  Szándékosan nincs hozzá npm-csomag: az appnak nincs futásidejű függősége,
 *  és egy adószámolónál egy letöltő lánc minden eleme kockázat.
 */
function zipBejegyzesek(buf) {
  var eocd = -1;
  for (var i = buf.length - 22; i >= 0 && i > buf.length - 70000; i--)
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('nem ZIP (nincs central directory vége)');
  var cdOff = buf.readUInt32LE(eocd + 16);
  var cdCnt = buf.readUInt16LE(eocd + 10);
  var ki = {}, p = cdOff;
  for (var n = 0; n < cdCnt; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('sérült ZIP-katalógus');
    var nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    ki[buf.toString('utf8', p + 46, p + 46 + nl)] = {
      tomorites: buf.readUInt16LE(p + 10),
      tomoritettMeret: buf.readUInt32LE(p + 20),
      lho: buf.readUInt32LE(p + 42)
    };
    p += 46 + nl + el + cl;
  }
  return ki;
}

function zipKibont(buf, e) {
  if (!e) throw new Error('hiányzó bejegyzés a ZIP-ben');
  if (buf.readUInt32LE(e.lho) !== 0x04034b50) throw new Error('sérült ZIP-fejléc');
  var nl = buf.readUInt16LE(e.lho + 26), el = buf.readUInt16LE(e.lho + 28);
  var kezd = e.lho + 30 + nl + el;
  var adat = buf.subarray(kezd, kezd + e.tomoritettMeret);
  if (e.tomorites === 0) return adat.toString('utf8');
  if (e.tomorites === 8) return zlib.inflateRawSync(adat, { maxOutputLength: 256 * 1024 * 1024 })
                                    .toString('utf8');
  throw new Error('ismeretlen tömörítés: ' + e.tomorites);
}

/* ==========================================================================
 *  2. XLSX → táblázat
 * ======================================================================== */
function xmlKiold(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g,
      function (_, d) { return String.fromCharCode(+d); })
    .replace(/&amp;/g, '&');
}

/** Excel dátum-sorszám → ISO nap. A 0. nap 1899-12-30 (az 1900-as
 *  szökőév-hiba miatt); 61 alatti sorszám nem fordul elő ebben a fájlban. */
function excelNap(n) {
  if (!(n >= 61)) throw new Error('értelmezhetetlen dátum-sorszám: ' + n);
  return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
}

function xlsxBeolvas(buf) {
  var E = zipBejegyzesek(buf);
  var ssNev = Object.keys(E).filter(function (k) { return /sharedStrings\.xml$/.test(k); })[0];
  var SZ = [];
  if (ssNev) {
    var ss = zipKibont(buf, E[ssNev]);
    /* Egy <si> több <t>-ből is állhat (rich text) — ezért si-nként fűzzük össze. */
    var siRe = /<si>([\s\S]*?)<\/si>/g, m;
    while ((m = siRe.exec(ss)) !== null) {
      var t = '', tRe = /<t[^>]*>([\s\S]*?)<\/t>/g, tm;
      while ((tm = tRe.exec(m[1])) !== null) t += tm[1];
      SZ.push(xmlKiold(t));
    }
  }
  var lapNev = Object.keys(E).filter(function (k) {
    return /^xl\/worksheets\/sheet1\.xml$/.test(k); })[0];
  if (!lapNev) throw new Error('nincs xl/worksheets/sheet1.xml az XLSX-ben');
  var lap = zipKibont(buf, E[lapNev]);

  var sorok = [];
  var sorRe = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g, sm;
  while ((sm = sorRe.exec(lap)) !== null) {
    var cellak = {};
    var cRe = /<c r="([A-Z]+)\d+"([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g, cm;
    while ((cm = cRe.exec(sm[2])) !== null) {
      var torzs = cm[3] || '';
      var v = /<v>([\s\S]*?)<\/v>/.exec(torzs);
      if (!v) continue;
      cellak[cm[1]] = / t="s"/.test(cm[2]) ? (SZ[+v[1]] === undefined ? '' : SZ[+v[1]])
                                           : xmlKiold(v[1]);
    }
    sorok.push({ sor: +sm[1], cellak: cellak });
  }
  return sorok;
}

function oszlopNev(i) {          // 0 → A, 25 → Z, 26 → AA
  var s = '';
  i++;
  while (i > 0) { var r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = (i - r - 1) / 26; }
  return s;
}

/* ==========================================================================
 *  3. A TÁBLA ELŐÁLLÍTÁSA — szerkezeti ellenőrzésekkel
 * ========================================================================
 *  SZÁNDÉKOSAN SZIGORÚ. Ha az MNB megváltoztatja a fájl szerkezetét, nem egy
 *  „valamit valahogy kiolvastunk" tábla kell, hanem egy hangos leállás. Egy
 *  csendben elcsúszott oszlop az egész visszamenőleges adószámítást elrontaná.
 */
function feldolgoz(buf) {
  var sorok = xlsxBeolvas(buf);
  if (sorok.length < 3) throw new Error('az XLSX-ben nincs elég sor (' + sorok.length + ')');

  var fejSor = sorok[0].cellak, egysegSor = sorok[1].cellak;
  if (String(fejSor.A || '').indexOf('Dátum') < 0)
    throw new Error('az első oszlop fejléce nem „Dátum/ISO", hanem „' + fejSor.A + '" — ' +
                    'az MNB megváltoztatta a fájl szerkezetét, ellenőrizd kézzel');
  if (String(egysegSor.A || '').indexOf('Egység') < 0)
    throw new Error('a második sor nem az „Egység" sor, hanem „' + egysegSor.A + '" — ' +
                    'az MNB megváltoztatta a fájl szerkezetét, ellenőrizd kézzel');

  /* Oszlop → deviza + egység. Az egység azért kritikus, mert pl. a JPY
     jegyzése 100 egységre szól: enélkül százszoros árfolyamot írnánk be. */
  var oszlopok = [];
  for (var i = 1; i < 200; i++) {
    var o = oszlopNev(i);
    var dev = fejSor[o];
    if (!dev) continue;
    dev = String(dev).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(dev)) continue;
    var egyseg = parseFloat(String(egysegSor[o] || '1').replace(',', '.'));
    if (!(egyseg > 0)) egyseg = 1;
    oszlopok.push({ oszlop: o, deviza: dev, egyseg: egyseg });
  }
  if (!oszlopok.length) throw new Error('egyetlen ISO-kódot sem találtam a fejlécben');

  var kellenek = DEVIZAK.filter(function (d) {
    return !oszlopok.some(function (x) { return x.deviza === d; }); });
  if (kellenek.length)
    throw new Error('hiányzó deviza az MNB fájlban: ' + kellenek.join(', '));

  var tabla = {}, db = 0, utolsoNap = null, elsoNap = null;
  var kertek = {};
  DEVIZAK.forEach(function (d) { kertek[d] = 1; });

  for (var s = 2; s < sorok.length; s++) {
    var c = sorok[s].cellak;
    var nyers = c.A;
    if (nyers === undefined || nyers === '') continue;
    var nap;
    try { nap = excelNap(parseFloat(nyers)); } catch (e) { continue; }
    if (nap < KEZDET) continue;
    if (!elsoNap || nap < elsoNap) elsoNap = nap;
    if (!utolsoNap || nap > utolsoNap) utolsoNap = nap;
    oszlopok.forEach(function (x) {
      if (!kertek[x.deviza]) return;
      var ny = c[x.oszlop];
      if (ny === undefined || ny === '') return;              // aznap nincs jegyzés
      var ertek = parseFloat(String(ny).replace(',', '.'));
      if (!(ertek > 0)) return;
      if (!tabla[x.deviza]) tabla[x.deviza] = {};
      tabla[x.deviza][nap] = Math.round((ertek / x.egyseg) * 1e6) / 1e6;
      db++;
    });
  }

  if (!db) throw new Error('egyetlen árfolyamadat sem jött ki a ' + KEZDET + ' utáni időszakra');
  return { tabla: tabla, db: db, elsoNap: elsoNap, utolsoNap: utolsoNap, oszlopok: oszlopok };
}

/* ==========================================================================
 *  4. ÖSSZEVETÉS a meglévő (SOAP-ból származó) táblával
 * ========================================================================
 *  Ez az igazi haszon: KÉT független hivatalos út ugyanahhoz az adathoz.
 *  Ha eltérnek, azt tudni kell — nem elsimítani.
 */
function osszevet(uj) {
  var regi = null;
  try { regi = require(KIMENET); } catch (e) {
    console.error('  [HIBA] A meglévő tábla nem olvasható: ' + KIMENET);
    process.exit(2);
  }
  var kozos = 0, elteres = [], csakUj = 0, csakRegi = 0;
  Object.keys(uj.tabla).forEach(function (d) {
    var r = regi[d] || {};
    Object.keys(uj.tabla[d]).forEach(function (nap) {
      if (r[nap] === undefined) { csakUj++; return; }
      kozos++;
      /* Kerekítési tűrés: mindkét forrás 6 tizedesre kerekít, de más úton. */
      if (Math.abs(r[nap] - uj.tabla[d][nap]) > 1e-6)
        elteres.push({ deviza: d, nap: nap, regi: r[nap], uj: uj.tabla[d][nap] });
    });
  });
  Object.keys(regi).forEach(function (d) {
    var u = uj.tabla[d] || {};
    Object.keys(regi[d]).forEach(function (nap) { if (u[nap] === undefined) csakRegi++; });
  });

  console.log('');
  console.log('  ÖSSZEVETÉS — SOAP-ból származó tábla  vs.  HTTPS XLSX');
  console.log('  ' + '-'.repeat(56));
  console.log('  közös adatpont:            ' + kozos);
  console.log('  csak az XLSX-ben:          ' + csakUj);
  console.log('  csak a meglévő táblában:   ' + csakRegi);
  console.log('  ELTÉRŐ ÉRTÉK:              ' + elteres.length);
  elteres.slice(0, 20).forEach(function (e) {
    console.log('    ⛔ ' + e.deviza + ' ' + e.nap + ': meglévő ' + e.regi + '  ≠  XLSX ' + e.uj);
  });
  if (elteres.length > 20) console.log('    … és még ' + (elteres.length - 20));
  console.log('');
  if (elteres.length) {
    console.log('  [ELTÉRÉS] A két hivatalos forrás nem ugyanazt mondja. Ezt KI KELL');
    console.log('            vizsgálni, mielőtt bármelyikkel adót számolnál.');
    process.exit(1);
  }
  if (!kozos) {
    console.log('  [FIGYELEM] Nincs közös adatpont — az összevetés nem mondott semmit.');
    process.exit(1);
  }
  console.log('  [OK] A két független MNB-forrás minden közös napon egyezik.');
  process.exit(0);
}

/* ==========================================================================
 *  5. KIÍRÁS
 * ======================================================================== */
/**
 * A nyilvános feed objektuma. Külön függvény, mert ez a SZERZŐDÉS a letöltő
 * és a kiadott appban futó `web/arfolyam-frissito.js` között — és ezt a
 * szerződést teszt méri, nem feltételezés tartja össze.
 */
function feedObjektum(uj) {
  var egysegek = {};
  (uj.oszlopok || []).forEach(function (x) {
    if (uj.tabla[x.deviza]) egysegek[x.deviza] = x.egyseg; });
  return {
    formatum: 'mnb-arfolyam-1',
    forras: FORRAS,
    forrasNeve: 'Magyar Nemzeti Bank hivatalos devizaárfolyamai',
    forrasJogi: 'Az MNB jogi nyilatkozata szerint a honlapon szereplő ' +
                'információk változatlan tartalommal, a forrás megjelölésével ' +
                'szabadon terjeszthetők.',
    keszult: new Date().toISOString(),
    tol: uj.elsoNap, ig: uj.utolsoNap,
    egysegek: egysegek,
    arfolyamok: uj.tabla
  };
}

function kiir(uj) {
  /* Nem írunk felül kevesebb adattal: egy csonka letöltés csendben
     tönkretenné a visszamenőleges reprodukálhatóságot. */
  var regi = null;
  try { regi = require(KIMENET); } catch (e) { regi = null; }
  if (regi) {
    var regiDb = 0;
    Object.keys(regi).forEach(function (d) { regiDb += Object.keys(regi[d]).length; });
    if (uj.db < regiDb) {
      console.error('  [HIBA] A letöltött tábla KEVESEBB adatot tartalmaz, mint a meglévő ' +
                    '(' + uj.db + ' < ' + regiDb + ').');
      console.error('         A meglévő tábla VÁLTOZATLAN marad.');
      process.exit(1);
    }
  }

  var most = new Date();
  function ket(x) { return x < 10 ? '0' + x : '' + x; }
  var idobelyeg = most.getFullYear() + '-' + ket(most.getMonth() + 1) + '-' + ket(most.getDate()) +
                  ' ' + ket(most.getHours()) + ':' + ket(most.getMinutes());

  var devizak = Object.keys(uj.tabla).sort();
  var ki = '/* MNB hivatalos devizaarfolyamok - GENERALT FAJL, ne szerkeszd kezzel!\n' +
           '   Forras: ' + FORRAS + ' (hivatalos MNB arfolyam-idosor, HTTPS)\n' +
           '   Frissitve: ' + idobelyeg + '  |  ' + uj.elsoNap + ' .. ' + uj.utolsoNap + ' */\n' +
           'var ARFOLYAMOK = {\n';
  devizak.forEach(function (d) {
    var napok = Object.keys(uj.tabla[d]).sort().map(function (k) {
      return '"' + k + '":' + uj.tabla[d][k]; });
    ki += '  "' + d + '": {' + napok.join(',') + '},\n';
  });
  ki += '};\n';
  ki += 'var ARFOLYAM_META = {letoltve:"' + idobelyeg + '", forras:"MNB arfolyam.xlsx (HTTPS)", ' +
        'tol:"' + uj.elsoNap + '", ig:"' + uj.utolsoNap + '"};\n';
  ki += "if (typeof module === 'object' && module.exports) module.exports = ARFOLYAMOK;\n";

  fs.writeFileSync(KIMENET, ki, 'utf8');

  /* ------------------------------------------------------------------
     A NYILVÁNOS FEED. Ugyanaz az adat JSON-ként, hogy egy KIADOTT app egy
     idegen gépen is tudja frissíteni magát. Azért külön fájl és azért JSON:
     futtatható JS-t soha nem töltünk le és nem `eval`-ozunk.

     Az MNB jogi nyilatkozata a terjesztést „változatlan tartalommal, a forrás
     megjelölésével" engedi. Ezért a feed magával viszi a forrás URL-jét, a
     forrás nevét, és az MNB által közzétett JEGYZÉSI EGYSÉGET is — a JPY-t
     például 100 egységre jegyzik, és e nélkül a szám nem értelmezhető.
     ------------------------------------------------------------------ */
  fs.writeFileSync(FEED, JSON.stringify(feedObjektum(uj)), 'utf8');

  console.log('  ' + uj.db + ' árfolyam-adat, ' + devizak.length + ' devizában.');
  console.log('  [KÉSZ] ' + KIMENET);
  console.log('  [KÉSZ] ' + FEED + '  (nyilvános feed a kiadott apphoz)');
  console.log('         Utolsó jegyzési nap a táblában: ' + uj.utolsoNap);
}

/* ==========================================================================
 *  6. FŐ ÁG
 * ======================================================================== */
function fut(buf) {
  var uj;
  try { uj = feldolgoz(buf); }
  catch (e) {
    console.error('  [HIBA] Az MNB XLSX feldolgozása nem sikerült: ' + e.message);
    console.error('         A meglévő tábla VÁLTOZATLAN marad.');
    process.exit(1);
  }
  if (ELLENORIZ) osszevet(uj); else kiir(uj);
}

/* Tesztelhetőség: `require`-ölve CSAK a függvényeket adja, nem tölt le semmit.
   A hálózatot igénylő rész kizárólag közvetlen indításnál fut le — így a
   feldolgozó logika szintetikus XLSX-en, hálózat nélkül is tesztelhető. */
module.exports = {
  zipBejegyzesek: zipBejegyzesek, zipKibont: zipKibont,
  xlsxBeolvas: xlsxBeolvas, oszlopNev: oszlopNev, excelNap: excelNap,
  feldolgoz: feldolgoz, feedObjektum: feedObjektum,
  FORRAS: FORRAS, DEVIZAK: DEVIZAK,
  kezdetetAllit: function (d) { KEZDET = d; }
};

if (require.main !== module) {
  /* modulként használva itt megállunk */
} else if (HELYI) {
  fut(fs.readFileSync(HELYI));
} else {
  console.log('');
  console.log('  MNB hivatalos árfolyam-idősor letöltése (HTTPS XLSX)');
  console.log('  ' + FORRAS);
  console.log('  kezdőnap: ' + KEZDET + (ELLENORIZ ? '   [csak összevetés, nem ír]' : ''));

  https.get(FORRAS, { headers: { 'User-Agent': 'revolut-ado/arfolyam-letolt' } }, function (v) {
    if (v.statusCode !== 200) {
      console.error('  [HIBA] Az MNB ' + v.statusCode + ' státusszal válaszolt.');
      console.error('         A meglévő tábla VÁLTOZATLAN marad.');
      v.resume();
      process.exit(1);
    }
    var darabok = [];
    v.on('data', function (c) { darabok.push(c); });
    v.on('end', function () { fut(Buffer.concat(darabok)); });
  }).on('error', function (e) {
    console.error('  [HIBA] Nem sikerült elérni az MNB fájlt: ' + e.message);
    console.error('         A meglévő tábla VÁLTOZATLAN marad.');
    process.exit(1);
  });
}
