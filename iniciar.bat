@echo off
REM Sobe a loja sem precisar de administrador.
REM Usa o Node do PATH ou um Node portatil extraido na pasta "node" ao lado deste arquivo.
cd /d "%~dp0"
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"
where node >nul 2>nul || (echo Node.js nao encontrado. Veja o README, secao "Como rodar". & pause & exit /b 1)
if not exist node_modules (call npm install --no-audit --no-fund || (pause & exit /b 1))
call npm run build || (pause & exit /b 1)
call npm start
pause
