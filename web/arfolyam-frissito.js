/* ============================================================================
 *  arfolyam-frissito.js — az árfolyamtábla frissítése EGY IDEGEN GÉPEN
 *  ---------------------------------------------------------------------------
 *  MIÉRT VAN EZ, ÉS MIÉRT ÍGY.
 *
 *  Amíg az app csak a fejlesztő gépén futott, az árfolyamtábla frissítése egy
 *  .bat fájl volt. Egy kiadott terméknél ez nem működik: aki megveszi, nem nyit
 *  terminált, nem futtat Node-ot, és nem csinál `git pull`-t. Nála a beépített
 *  tábla egy PILLANATFELVÉTEL, ami a telepítés napjától avul.
 *
 *  Az MNB-t az app KÖZVETLENÜL nem tudja lekérdezni — ez mérés, nem vélemény:
 *    · a SOAP szolgáltatás csak sima HTTP-n él (a HTTPS-es POST 404),
 *      és sima HTTP-t egy https:// vagy file:// oldalról a böngésző blokkol;
 *    · a HTTPS-es XLSX-re az MNB NEM küld CORS-fejlécet — idegen originről
 *      a fetch „Failed to fetch" hibával elszáll. Ellenőrizve.
 *
 *  Marad az egyetlen működő felállás:
 *
 *      MNB  →  napi GitHub Actions  →  nyilvános, CORS-os feed  →  ez a modul
 *
 *  A feed KIZÁRÓLAG JSON. Soha nem töltünk le futtatható JS-t és nem
 *  `eval`-ozunk: egy letöltött fájl idegen bemenet, és egy adószámoló appban
 *  a kódfuttatás a legrosszabb, ami történhet.
 *
 *  A LETÖLTÖTT TÁBLA NEM MEGBÍZHATÓ, AMÍG BE NEM BIZONYÍTJA.
 *  A legerősebb ellenőrzés az ÁTFEDÉS: a beépített táblában már benne lévő
 *  napokon a letöltött értékeknek PONTOSAN egyezniük kell. Aki rossz
 *  árfolyamot akarna becsempészni, ezen fennakad — a múltat nem tudja
 *  visszamenőleg átírni anélkül, hogy az eltérés ki ne bukna.
 *  Bármelyik ellenőrzés bukik → az EGÉSZ feedet eldobjuk, és marad a beépített
 *  tábla. Részlegesen soha nem alkalmazzuk.
 *
 *  ADATVÉDELEM. Ez egy GET egy nyilvános árfolyamfájlra. Semmit nem küld a
 *  felhasználóról: se dokumentumot, se tételt, se azonosítót, és nincs se
 *  query paraméter, se süti. Az „a dokumentumaid nem hagyják el a géped"
 *  ígéret érintetlen marad. Ettől még a feed kiszolgálója LÁTJA a letöltő
 *  IP-címét — ezért a frissítés ALAPBÓL KI VAN KAPCSOLVA, és a felület
 *  megmondja, mi történik, mielőtt bekapcsolnád.
 *
 *  JOGI HÁTTÉR. Az MNB jogi nyilatkozata szerint a honlapon szereplő
 *  információk „változatlan tartalommal, a forrás megjelölésével szabadon
 *  terjeszthetők". Ezért a feed magával viszi a forrás megnevezését és az
 *  MNB által közzétett JEGYZÉSI EGYSÉGET is (a JPY pl. 100 egységre szól),
 *  a felület pedig kiírja a forrást.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var FORMATUM = 'mnb-arfolyam-1';
  /* Egy deviza sem ér ennyi forintot. Nem a pontosságot védi, hanem a
     nagyságrendi képtelenséget fogja meg (elcsúszott tizedes, hibás egység). */
  var FELSO_HATAR_FT = 100000;
  var MAX_MERET = 8 * 1024 * 1024;      // a nyers válasz felső korlátja
  var JOVO_TURES_NAP = 3;               // időzóna és közzétételi csúszás miatt

  function ujEredmeny() {
    return { ok: false, hibak: [], figyelmeztetesek: [], statisztika: null };
  }
  function hiba(e, kod, uzenet) { e.hibak.push({ kod: kod, uzenet: uzenet }); }
  function figy(e, kod, uzenet) { e.figyelmeztetesek.push({ kod: kod, uzenet: uzenet }); }

  function napE(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function maiNap(ma) { return ma || new Date().toISOString().slice(0, 10); }
  function napPlusz(nap, n) {
    return new Date(Date.parse(nap + 'T00:00:00Z') + n * 86400000)
      .toISOString().slice(0, 10);
  }

  function tablaStat(tabla) {
    var db = 0, utolso = null, elso = null, devizak = Object.keys(tabla || {});
    devizak.forEach(function (d) {
      Object.keys(tabla[d] || {}).forEach(function (nap) {
        db++;
        if (!utolso || nap > utolso) utolso = nap;
        if (!elso || nap < elso) elso = nap;
      });
    });
    return { devizak: devizak.sort(), db: db, elso: elso, utolso: utolso };
  }

  /* ======================================================================
   *  ÉRVÉNYESÍTÉS — minden szabály külön kód, mert mindegyikre van teszt
   * ==================================================================== */
  /**
   * @param feed        a letöltött, MÁR JSON-ként értelmezett objektum
   * @param beepitett   a bundle-ben lévő ARFOLYAMOK tábla (ez az etalon)
   * @param opciok      { maiNap }
   */
  function ervenyesit(feed, beepitett, opciok) {
    opciok = opciok || {};
    var e = ujEredmeny();
    var ma = maiNap(opciok.maiNap);

    if (!feed || typeof feed !== 'object' || Array.isArray(feed)) {
      hiba(e, 'NEM_OBJEKTUM', 'A letöltött adat nem objektum.');
      return e;
    }
    if (feed.formatum !== FORMATUM) {
      hiba(e, 'ROSSZ_FORMATUM', 'Ismeretlen formátum: „' + feed.formatum + '" ' +
        '(várt: „' + FORMATUM + '"). Lehet, hogy az app régebbi, mint a feed.');
      return e;
    }
    /* Az MNB jogi nyilatkozata a FORRÁS MEGJELÖLÉSÉHEZ köti a terjesztést.
       Forrásmegjelölés nélküli feedet ezért nem fogadunk el. */
    if (typeof feed.forras !== 'string' || !/(^|\.)mnb\.hu\//.test(feed.forras)) {
      hiba(e, 'NINCS_FORRAS', 'A feed nem jelöli meg az MNB-t forrásként ' +
        '(„forras" mező). Forrásmegjelölés nélkül nem használjuk fel.');
      return e;
    }

    var tabla = feed.arfolyamok;
    if (!tabla || typeof tabla !== 'object' || Array.isArray(tabla) ||
        !Object.keys(tabla).length) {
      hiba(e, 'URES_TABLA', 'A feedben nincs árfolyamtábla.');
      return e;
    }

    /* --- szerkezet és értéktartomány --------------------------------- */
    var rosszDeviza = [], rosszNap = [], rosszErtek = [];
    Object.keys(tabla).forEach(function (d) {
      if (!/^[A-Z]{3}$/.test(d)) { rosszDeviza.push(d); return; }
      var sor = tabla[d];
      if (!sor || typeof sor !== 'object' || Array.isArray(sor)) {
        rosszDeviza.push(d); return;
      }
      Object.keys(sor).forEach(function (nap) {
        if (!napE(nap)) { if (rosszNap.length < 5) rosszNap.push(d + ' ' + nap); return; }
        var v = sor[nap];
        if (typeof v !== 'number' || !isFinite(v) || v <= 0 || v >= FELSO_HATAR_FT)
          if (rosszErtek.length < 5) rosszErtek.push(d + ' ' + nap + ' = ' + v);
      });
    });
    if (rosszDeviza.length)
      hiba(e, 'ROSSZ_DEVIZA', 'Érvénytelen devizakód a feedben: ' +
        rosszDeviza.slice(0, 5).join(', '));
    if (rosszNap.length)
      hiba(e, 'ROSSZ_NAP', 'Érvénytelen dátum a feedben: ' + rosszNap.join(', '));
    if (rosszErtek.length)
      hiba(e, 'ROSSZ_ERTEK', 'Értelmetlen árfolyamérték a feedben: ' +
        rosszErtek.join(', '));
    if (e.hibak.length) return e;

    var uj = tablaStat(tabla);
    var regi = tablaStat(beepitett || {});

    /* --- jövőbeli adat ------------------------------------------------ */
    if (uj.utolso > napPlusz(ma, JOVO_TURES_NAP)) {
      hiba(e, 'JOVOBELI', 'A feed utolsó napja (' + uj.utolso + ') a jövőben van ' +
        '(ma: ' + ma + '). Ez hibás vagy manipulált fájlra utal.');
      return e;
    }

    /* --- nem veszíthetünk devizát ------------------------------------- */
    var hianyzo = regi.devizak.filter(function (d) { return uj.devizak.indexOf(d) < 0; });
    if (hianyzo.length) {
      hiba(e, 'HIANYZO_DEVIZA', 'A feedből hiányzik olyan deviza, ami a beépített ' +
        'táblában megvan: ' + hianyzo.join(', ') + '. Nem cseréljük le.');
      return e;
    }

    /* --- nem cserélünk régebbire és nem cserélünk kevesebbre ---------- */
    if (regi.utolso && uj.utolso < regi.utolso) {
      hiba(e, 'REGEBBI', 'A feed (' + uj.utolso + ') RÉGEBBI, mint a beépített ' +
        'tábla (' + regi.utolso + '). Marad a beépített.');
      return e;
    }
    if (uj.db < regi.db) {
      hiba(e, 'KEVESEBB_ADAT', 'A feed kevesebb adatpontot tartalmaz (' + uj.db +
        ' < ' + regi.db + '). Csonka fájlra utal, nem cseréljük le.');
      return e;
    }

    /* --- A LEGERŐSEBB ELLENŐRZÉS: ÁTFEDÉS -----------------------------
       A már ismert napokon a letöltött értéknek PONTOSAN egyeznie kell.
       Ez az, ami egy rosszindulatú vagy elrontott feedet megfog: a múltat
       nem lehet átírni úgy, hogy közben egyezzen azzal, amit már tudunk. */
    var atfedes = 0, eltero = [];
    Object.keys(beepitett || {}).forEach(function (d) {
      var r = beepitett[d], u = tabla[d] || {};
      Object.keys(r).forEach(function (nap) {
        if (u[nap] === undefined) return;
        atfedes++;
        if (Math.abs(u[nap] - r[nap]) > 1e-9 && eltero.length < 5)
          eltero.push(d + ' ' + nap + ': beépített ' + r[nap] + ' ≠ feed ' + u[nap]);
      });
    });
    if (eltero.length) {
      hiba(e, 'ATFEDES_ELTER', 'A feed MÁST mond a már ismert napokra: ' +
        eltero.join('; ') + '. Az egész feedet eldobjuk.');
      return e;
    }
    if (regi.db > 0 && atfedes === 0) {
      hiba(e, 'NINCS_ATFEDES', 'A feednek nincs egyetlen közös napja sem a ' +
        'beépített táblával, tehát nem ellenőrizhető. Nem cseréljük le.');
      return e;
    }

    /* --- rendben, de mondjuk meg, mit nyerünk vele -------------------- */
    if (regi.utolso && uj.utolso === regi.utolso)
      figy(e, 'NINCS_UJ_NAP', 'A feed nem hoz új jegyzési napot (' + uj.utolso +
        '), de érvényes.');

    e.ok = true;
    e.statisztika = {
      feed: uj, beepitett: regi, atfedes: atfedes,
      ujNapok: regi.utolso ? 0 : uj.db,
      keszult: typeof feed.keszult === 'string' ? feed.keszult : null,
      forras: feed.forras,
      forrasNeve: typeof feed.forrasNeve === 'string' ? feed.forrasNeve : null,
      egysegek: (feed.egysegek && typeof feed.egysegek === 'object') ? feed.egysegek : null
    };
    return e;
  }

  /* ======================================================================
   *  EGYESÍTÉS — a feed kiegészíti a beépítettet, nem törli
   * ====================================================================
   *  Az átfedés-ellenőrzés miatt itt már tudjuk, hogy a közös napokon
   *  egyeznek. Azért egyesítünk és nem cserélünk, hogy egy szűkebb
   *  időtávot lefedő feed se vegyen el régi adatot.
   */
  function egyesit(feed, beepitett) {
    var ki = {};
    Object.keys(beepitett || {}).forEach(function (d) {
      ki[d] = {};
      Object.keys(beepitett[d]).forEach(function (n) { ki[d][n] = beepitett[d][n]; });
    });
    var t = (feed && feed.arfolyamok) || {};
    Object.keys(t).forEach(function (d) {
      if (!ki[d]) ki[d] = {};
      Object.keys(t[d]).forEach(function (n) { ki[d][n] = t[d][n]; });
    });
    return ki;
  }

  /* ======================================================================
   *  LETÖLTÉS — csak JSON, méretkorláttal, soha nem futtatunk semmit
   * ==================================================================== */
  /**
   * @param url        a feed címe (fix, paraméter nélküli URL)
   * @param beepitett  a bundle-beli tábla
   * @param opciok     { fetchFn, maiNap, idokorlatMs }
   */
  function letolt(url, beepitett, opciok) {
    opciok = opciok || {};
    var F = opciok.fetchFn || (typeof fetch === 'function' ? fetch : null);
    if (!F) return Promise.resolve(halalos('NINCS_FETCH',
      'Ebben a környezetben nincs hálózati lekérdezés.'));
    if (typeof url !== 'string' || !/^https:\/\//.test(url))
      return Promise.resolve(halalos('ROSSZ_URL',
        'A feed címe nem https:// kezdetű: ' + url));
    /* Paraméteres URL-t nem engedünk: semmi nem mehet ki a felhasználóról. */
    if (/[?#]/.test(url))
      return Promise.resolve(halalos('PARAMETERES_URL',
        'A feed címe nem tartalmazhat query paramétert vagy horgonyt.'));

    return F(url, { method: 'GET', credentials: 'omit', cache: 'no-store',
                    referrerPolicy: 'no-referrer' })
      .then(function (v) {
        if (!v || !v.ok)
          return halalos('HTTP', 'A feed nem érhető el (HTTP ' +
            (v && v.status) + ').');
        var hossz = v.headers && v.headers.get && v.headers.get('content-length');
        if (hossz && +hossz > MAX_MERET)
          return halalos('TUL_NAGY', 'A feed túl nagy (' + hossz + ' bájt).');
        return v.text().then(function (sz) {
          if (sz.length > MAX_MERET)
            return halalos('TUL_NAGY', 'A feed túl nagy (' + sz.length + ' karakter).');
          var adat;
          try { adat = JSON.parse(sz); }
          catch (x) { return halalos('NEM_JSON',
            'A feed nem érvényes JSON: ' + x.message); }
          var e = ervenyesit(adat, beepitett, { maiNap: opciok.maiNap });
          if (e.ok) e.tabla = egyesit(adat, beepitett);
          return e;
        });
      })
      .catch(function (x) {
        return halalos('HALOZAT', 'A feed letöltése nem sikerült: ' +
          (x && x.message ? x.message : x));
      });

    function halalos(kod, uzenet) {
      var e = ujEredmeny(); hiba(e, kod, uzenet); return e;
    }
  }

  var API = {
    FORMATUM: FORMATUM,
    FELSO_HATAR_FT: FELSO_HATAR_FT,
    JOVO_TURES_NAP: JOVO_TURES_NAP,
    tablaStat: tablaStat,
    ervenyesit: ervenyesit,
    egyesit: egyesit,
    letolt: letolt
  };

  if (typeof module === 'object' && module.exports) module.exports = API;
  else root.ArfolyamFrissito = API;

})(typeof self !== 'undefined' ? self : this);
