/* ============================================================================
 *  teszt-arfolyam-frissito.js — a letöltött árfolyamtábla ellenőrzése
 *  ---------------------------------------------------------------------------
 *  EZ NEM SZOKÁSOS EGYSÉGTESZT. A letöltött feed IDEGEN BEMENET: egy kiadott
 *  terméknél nem a fejlesztő gépéről jön, hanem a hálózatról. Ezért itt nem
 *  csak azt mérjük, hogy a jó adat átmegy-e, hanem azt is, hogy a ROSSZ adat
 *  fennakad-e — beleértve azt az esetet, amikor valaki szándékosan hamis
 *  árfolyamot próbál becsempészni.
 *
 *  Egy adószámolóban a rossz árfolyam csendben rossz adóalapot ad. Ha egyetlen
 *  ellenőrzés kilyukad, az nem elméleti hiba: az a felhasználó rossz számot ad
 *  be a NAV-nak.
 *
 *  Futtatás: node eszkozok/teszt-arfolyam-frissito.js
 * ==========================================================================*/
'use strict';
var path = require('path');
var F = require(path.join(__dirname, '..', 'web', 'arfolyam-frissito.js'));

var db = 0, hiba = 0;
function all(nev, felt, uzenet) {
  db++;
  if (felt) console.log('  ✓ ' + nev);
  else { hiba++; console.log('  ✗ ' + nev + (uzenet ? '\n      ' + uzenet : '')); }
}
function ok(nev, kapott, vart) {
  db++;
  if (JSON.stringify(kapott) !== JSON.stringify(vart)) {
    hiba++;
    console.log('  ✗ ' + nev + '\n      kapott: ' + JSON.stringify(kapott) +
                '\n      várt:   ' + JSON.stringify(vart));
  } else console.log('  ✓ ' + nev);
}
function csoport(c) { console.log('\n' + c); }

/* A „beépített" tábla, ami a telepítőben van: ez az etalon. */
var BEEPITETT = {
  USD: { '2026-09-18': 316.53, '2026-09-21': 315.85, '2026-09-22': 315.7 },
  EUR: { '2026-09-18': 363.47, '2026-09-21': 362.6,  '2026-09-22': 361.73 },
  JPY: { '2026-09-18': 2.0059, '2026-09-21': 2.0086, '2026-09-22': 2.0085 }
};
var MA = '2026-09-25';

function feed(v) {
  var alap = {
    formatum: 'mnb-arfolyam-1',
    forras: 'https://www.mnb.hu/Root/ExchangeRate/arfolyam.xlsx',
    forrasNeve: 'Magyar Nemzeti Bank hivatalos devizaárfolyamai',
    keszult: '2026-09-25T15:32:00Z',
    egysegek: { USD: 1, EUR: 1, JPY: 100 },
    arfolyamok: {
      USD: { '2026-09-18': 316.53, '2026-09-21': 315.85, '2026-09-22': 315.7,
             '2026-09-23': 314.9, '2026-09-24': 314.1, '2026-09-25': 313.8 },
      EUR: { '2026-09-18': 363.47, '2026-09-21': 362.6, '2026-09-22': 361.73,
             '2026-09-23': 361.1, '2026-09-24': 360.8, '2026-09-25': 360.2 },
      JPY: { '2026-09-18': 2.0059, '2026-09-21': 2.0086, '2026-09-22': 2.0085,
             '2026-09-23': 2.0, '2026-09-24': 1.99, '2026-09-25': 1.98 }
    }
  };
  if (typeof v === 'function') v(alap);
  return alap;
}
function er(f) { return F.ervenyesit(f, BEEPITETT, { maiNap: MA }); }
function kodjai(e) { return e.hibak.map(function (h) { return h.kod; }); }

/* ==================================================== a jó eset */
csoport('arfolyam-frissito.js — az érvényes feed átmegy');
var jo = er(feed());
all('elfogadja', jo.ok === true, JSON.stringify(kodjai(jo)));
ok('megszámolja az átfedést', jo.statisztika.atfedes, 9);
ok('látja a friss utolsó napot', jo.statisztika.feed.utolso, '2026-09-25');
ok('és a beépített régi utolsó napját', jo.statisztika.beepitett.utolso, '2026-09-22');
all('átveszi a forrásmegjelölést', /mnb\.hu/.test(jo.statisztika.forras));
all('átveszi a jegyzési egységeket (JPY=100)', jo.statisztika.egysegek.JPY === 100);

csoport('arfolyam-frissito.js — egyesítés: a régi adat nem vész el');
var egy = F.egyesit(feed(), BEEPITETT);
ok('az új nap bekerül', egy.USD['2026-09-25'], 313.8);
ok('a régi nap megmarad', egy.USD['2026-09-18'], 316.53);
ok('a JPY is egyesül', egy.JPY['2026-09-25'], 1.98);
var szukFeed = feed(function (f) {
  f.arfolyamok.USD = { '2026-09-22': 315.7, '2026-09-25': 313.8 };
  f.arfolyamok.EUR = { '2026-09-22': 361.73, '2026-09-25': 360.2 };
  f.arfolyamok.JPY = { '2026-09-22': 2.0085, '2026-09-25': 1.98 };
});
var egy2 = F.egyesit(szukFeed, BEEPITETT);
ok('szűkebb feed sem veszi el a régi napot', egy2.USD['2026-09-18'], 316.53);

/* ============================ HAMISÍTÁS: a legfontosabb ellenőrzés */
csoport('arfolyam-frissito.js — hamis árfolyam a MÚLTRA fennakad');
var hamis = er(feed(function (f) { f.arfolyamok.USD['2026-09-22'] = 999.99; }));
all('elutasítja', hamis.ok === false);
ok('a megfelelő kóddal', kodjai(hamis), ['ATFEDES_ELTER']);
all('és megmondja, hol tér el',
    /2026-09-22/.test(hamis.hibak[0].uzenet) && /999\.99/.test(hamis.hibak[0].uzenet),
    hamis.hibak[0].uzenet);

var picit = er(feed(function (f) { f.arfolyamok.JPY['2026-09-21'] = 2.0087; }));
all('a 0,0001-es eltérés is fennakad', picit.ok === false, JSON.stringify(kodjai(picit)));

csoport('arfolyam-frissito.js — nincs átfedés = nem ellenőrizhető = nem fogadjuk el');
var nincsAtfedes = er(feed(function (f) {
  f.arfolyamok = { USD: { '2030-01-02': 300 }, EUR: { '2030-01-02': 350 },
                   JPY: { '2030-01-02': 2 } };
}));
all('elutasítja', nincsAtfedes.ok === false);
ok('a megfelelő kóddal', kodjai(nincsAtfedes), ['JOVOBELI']);
var nincsAtfedes2 = er(feed(function (f) {
  f.arfolyamok = { USD: { '2026-09-24': 314.1 }, EUR: { '2026-09-24': 360.8 },
                   JPY: { '2026-09-24': 1.99 } };
}));
ok('átfedés nélküli, múltbeli feed is elbukik',
   kodjai(nincsAtfedes2).indexOf('KEVESEBB_ADAT') >= 0 ||
   kodjai(nincsAtfedes2).indexOf('NINCS_ATFEDES') >= 0, true);

/* ========================================= szerkezeti támadások */
csoport('arfolyam-frissito.js — szerkezeti hibák és támadások');
function elutasit(nev, valtoztat, vartKod) {
  var e = er(feed(valtoztat));
  all(nev, e.ok === false && kodjai(e).indexOf(vartKod) >= 0,
      'kapott kódok: ' + JSON.stringify(kodjai(e)));
}
elutasit('ismeretlen formátum', function (f) { f.formatum = 'valami-mas'; }, 'ROSSZ_FORMATUM');
elutasit('hiányzó forrásmegjelölés', function (f) { delete f.forras; }, 'NINCS_FORRAS');
elutasit('idegen forrás (nem MNB)',
         function (f) { f.forras = 'https://valami-mas.hu/arfolyam.xlsx'; }, 'NINCS_FORRAS');
elutasit('üres tábla', function (f) { f.arfolyamok = {}; }, 'URES_TABLA');
elutasit('érvénytelen devizakód',
         function (f) { f.arfolyamok['US'] = { '2026-09-22': 1 }; }, 'ROSSZ_DEVIZA');
elutasit('érvénytelen dátum',
         function (f) { f.arfolyamok.USD['2026.09.22'] = 300; }, 'ROSSZ_NAP');
elutasit('nulla árfolyam',
         function (f) { f.arfolyamok.USD['2026-09-24'] = 0; }, 'ROSSZ_ERTEK');
elutasit('negatív árfolyam',
         function (f) { f.arfolyamok.USD['2026-09-24'] = -5; }, 'ROSSZ_ERTEK');
elutasit('nagyságrendi képtelenség',
         function (f) { f.arfolyamok.USD['2026-09-24'] = 5000000; }, 'ROSSZ_ERTEK');
elutasit('szövegként átadott szám',
         function (f) { f.arfolyamok.USD['2026-09-24'] = '314.1'; }, 'ROSSZ_ERTEK');
elutasit('NaN érték',
         function (f) { f.arfolyamok.USD['2026-09-24'] = NaN; }, 'ROSSZ_ERTEK');
elutasit('jövőbeli utolsó nap',
         function (f) { f.arfolyamok.USD['2027-01-04'] = 300; }, 'JOVOBELI');
elutasit('eltűnt deviza',
         function (f) { delete f.arfolyamok.JPY; }, 'HIANYZO_DEVIZA');

var regebbi = F.ervenyesit(feed(function (f) {
  Object.keys(f.arfolyamok).forEach(function (d) {
    delete f.arfolyamok[d]['2026-09-23'];
    delete f.arfolyamok[d]['2026-09-24'];
    delete f.arfolyamok[d]['2026-09-25'];
  });
  f.arfolyamok.USD['2026-09-17'] = 317.46;
  f.arfolyamok.EUR['2026-09-17'] = 364.22;
  f.arfolyamok.JPY['2026-09-17'] = 2.038;
  delete f.arfolyamok.USD['2026-09-22'];
  delete f.arfolyamok.EUR['2026-09-22'];
  delete f.arfolyamok.JPY['2026-09-22'];
}), BEEPITETT, { maiNap: MA });
all('régebbi feedre nem cserél', regebbi.ok === false,
    JSON.stringify(kodjai(regebbi)));

csoport('arfolyam-frissito.js — nem objektum bemenetek');
[['null', null], ['szöveg', 'nem objektum'], ['szám', 42], ['tömb', [1, 2, 3]]]
  .forEach(function (p) {
    var e = F.ervenyesit(p[1], BEEPITETT, { maiNap: MA });
    all(p[0] + ' → elutasítva, nem dob kivételt', e.ok === false && e.hibak.length > 0);
  });

/* ======================================== a letöltés maga */
csoport('arfolyam-frissito.js — letöltés: csak https, paraméter nélkül, JSON');
function futtat(url, valasz) {
  var hivott = [];
  var fetchFn = function (u, o) {
    hivott.push({ u: u, o: o });
    return Promise.resolve(valasz);
  };
  return F.letolt(url, BEEPITETT, { fetchFn: fetchFn, maiNap: MA })
    .then(function (e) { e._hivott = hivott; return e; });
}
function valaszObj(test, allapot, fejlec) {
  return { ok: allapot === undefined ? true : allapot, status: allapot === false ? 500 : 200,
           headers: { get: function (k) { return (fejlec || {})[k] || null; } },
           text: function () { return Promise.resolve(test); } };
}

var lanc = Promise.resolve();
function lepes(fn) { lanc = lanc.then(fn); }

lepes(function () {
  return futtat('http://pelda.hu/arfolyam.json', valaszObj('{}')).then(function (e) {
    all('sima http:// URL-t elutasít', e.ok === false && kodjai(e)[0] === 'ROSSZ_URL');
    ok('és el sem indítja a kérést', e._hivott.length, 0);
  });
});
lepes(function () {
  return futtat('https://pelda.hu/arfolyam.json?ki=andris', valaszObj('{}'))
    .then(function (e) {
      all('paraméteres URL-t elutasít',
          e.ok === false && kodjai(e)[0] === 'PARAMETERES_URL');
      ok('és el sem indítja a kérést', e._hivott.length, 0);
    });
});
lepes(function () {
  return futtat('https://pelda.hu/arfolyam.json', valaszObj('nem json'))
    .then(function (e) {
      all('nem-JSON válasz → hiba, nem futtatás',
          e.ok === false && kodjai(e)[0] === 'NEM_JSON');
    });
});
lepes(function () {
  return futtat('https://pelda.hu/arfolyam.json', valaszObj('{}', false))
    .then(function (e) {
      all('HTTP-hiba → elutasítva', e.ok === false && kodjai(e)[0] === 'HTTP');
    });
});
lepes(function () {
  return futtat('https://pelda.hu/arfolyam.json',
                valaszObj('{}', true, { 'content-length': String(50 * 1024 * 1024) }))
    .then(function (e) {
      all('túl nagy fájl → elutasítva', e.ok === false && kodjai(e)[0] === 'TUL_NAGY');
    });
});
lepes(function () {
  return futtat('https://pelda.hu/arfolyam.json', valaszObj(JSON.stringify(feed())))
    .then(function (e) {
      all('érvényes feed → elfogadva', e.ok === true, JSON.stringify(kodjai(e)));
      ok('és megkapjuk az egyesített táblát', e.tabla.USD['2026-09-25'], 313.8);
      ok('a régi nap is benne van', e.tabla.USD['2026-09-18'], 316.53);
      var o = e._hivott[0].o;
      all('nem küld sütit', o.credentials === 'omit');
      all('nem küld referrert', o.referrerPolicy === 'no-referrer');
      all('nem használ gyorsítótárat', o.cache === 'no-store');
    });
});
lepes(function () {
  var fetchFn = function () { return Promise.reject(new Error('offline')); };
  return F.letolt('https://pelda.hu/arfolyam.json', BEEPITETT,
                  { fetchFn: fetchFn, maiNap: MA }).then(function (e) {
    all('offline → érthető hiba, nem kivétel',
        e.ok === false && kodjai(e)[0] === 'HALOZAT');
  });
});

lanc.then(function () {
  console.log('\n' + (hiba ? '✗ ' + hiba + ' hibás / ' + db
                           : '✓ mind a ' + db + ' frissítő-teszt jó'));
  process.exit(hiba ? 1 : 0);
});
