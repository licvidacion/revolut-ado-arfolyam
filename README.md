# MNB árfolyam-feed

A Magyar Nemzeti Bank hivatalos devizaárfolyamai, naponta frissítve, JSON-ban.

**A feed címe:**
`https://raw.githubusercontent.com/licvidacion/revolut-ado-arfolyam/main/web/arfolyamok.json`

## Forrás

Magyar Nemzeti Bank — hivatalos devizaárfolyamok
(`https://www.mnb.hu/Root/ExchangeRate/arfolyam.xlsx`, ellenőrzésként
`http://www.mnb.hu/arfolyamok.asmx`).

Az MNB jogi nyilatkozata szerint a honlapján szereplő információk
változatlan tartalommal, a forrás megjelölésével szabadon terjeszthetők.
Az értékek az MNB által közzétett árfolyamok, a jegyzési egységre
átszámolva (pl. JPY: 100 egység). A jegyzési egységek a feed `egysegek`
mezőjében szerepelnek.

## Hogyan frissül

Egy GitHub Actions munkafolyamat hétköznaponként letölti az árfolyamokat
**két független MNB-forrásból**, összeveti őket, és csak akkor ír, ha minden
közös napon egyeznek.

Ez a repó kizárólag nyilvános árfolyamadatot tartalmaz, személyes adatot nem.
