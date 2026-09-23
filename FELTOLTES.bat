@echo off
chcp 65001 >nul
cd /d "%~dp0"
title MNB arfolyam-feed feltoltese
color 0B

rem ===========================================================================
rem  Ezt a mappat tolti fel a NYILVANOS revolut-ado-arfolyam repoba.
rem  Egyszer kell lefuttatni. Utana a repo magatol frissul minden hetkoznap.
rem
rem  Csak ez a mappa megy fel: MNB-arfolyamok es a letolto szkript.
rem  A revolut-ado app kodja es a te adataid NEM.
rem ===========================================================================

set REPO=https://github.com/licvidacion/revolut-ado-arfolyam.git

echo.
echo  ==========================================================
echo    MNB arfolyam-feed feltoltese
echo  ==========================================================
echo.
echo  Cel: %REPO%
echo.

where git >nul 2>&1
if errorlevel 1 (
  color 0C
  echo  [HIBA] Nincs telepitve a git.
  pause
  exit /b 1
)

rem Biztonsagi kapu: szemelyes adat soha nem mehet fel ebbol a mappabol.
if exist "web\adat.js" goto :tiltott
if exist "filesFromRevolut" goto :tiltott
if exist "input" goto :tiltott
dir /b /s *.pdf >nul 2>&1 && goto :tiltott

if not exist ".git" (
  git init -b main
  git remote add origin %REPO%
)

git add -A
git commit -m "MNB arfolyam-feed" >nul 2>&1

git push -u origin main
if errorlevel 1 (
  color 0C
  echo.
  echo  [HIBA] A feltoltes nem sikerult. A leggyakoribb okok:
  echo    - meg nincs letrehozva a repo a GitHubon, vagy nem ez a neve
  echo    - a repot README-vel hoztad letre ^(uresen kell^)
  echo.
  pause
  exit /b 1
)

color 0A
echo.
echo  [KESZ] Feltoltve.
echo.
echo  Par perc mulva elkeszul az elso feed. Itt kovetheted:
echo    https://github.com/licvidacion/revolut-ado-arfolyam/actions
echo.
echo  A feed cime:
echo    https://raw.githubusercontent.com/licvidacion/revolut-ado-arfolyam/main/web/arfolyamok.json
echo.
pause
exit /b 0

:tiltott
color 0C
echo  [HIBA] Szemelyes adatnak latszo fajl van a mappaban. Nem toltom fel.
pause
exit /b 1
