@echo off
title Push AQUAPLANT to GitHub
cd /d "%~dp0"

echo ============================================
echo  Pushing AQUAPLANT to GitHub
echo ============================================
echo.
echo A browser window will open. Sign in to GitHub
echo and click "Authorize" to allow Git to push.
echo.
pause

git push -u origin main

echo.
echo ============================================
if %errorlevel%==0 (
  echo  SUCCESS - code is on GitHub
  echo  https://github.com/christianjampolina86-glitch/Aquaplant
) else (
  echo  PUSH FAILED - see the message above
)
echo ============================================
pause
