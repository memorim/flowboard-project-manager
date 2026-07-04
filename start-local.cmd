@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (
  echo Node.js 22 or newer is required: https://nodejs.org/
  pause
  exit /b 1
)
where pnpm >nul 2>nul || call corepack enable
call pnpm install || goto :error
call pnpm build || goto :error
start "Flowboard" http://localhost:4100
call pnpm start
exit /b 0
:error
echo Failed to start Flowboard.
pause
exit /b 1

