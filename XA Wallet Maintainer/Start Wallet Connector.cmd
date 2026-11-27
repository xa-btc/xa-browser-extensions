@echo off
setlocal
if exist "%SystemRoot%\py.exe" (
    "%SystemRoot%\py.exe" -3 "%~dp0serve.py"
) else if exist "%LocalAppData%\Programs\Python\Python312\python.exe" (
    "%LocalAppData%\Programs\Python\Python312\python.exe" "%~dp0serve.py"
) else (
    python.exe "%~dp0serve.py"
)
set "connectorResult=%errorlevel%"
if not "%connectorResult%"=="0" pause
exit /b %connectorResult%
