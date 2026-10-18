@echo off
REM Start quill-mcp in HTTP mode for remote access.
REM
REM Usage:
REM   start-http.bat                        Default: port 3000, localhost only
REM   start-http.bat --port 8080            Custom port
REM   start-http.bat --host 0.0.0.0         Bind to all interfaces (use with auth)
REM   start-http.bat --auth-token SECRET    Require Bearer token auth
REM
REM Environment variables:
REM   QUILL_HTTP_ENABLED=true   Enable HTTP mode
REM   QUILL_HTTP_PORT=3000      HTTP port
REM   QUILL_HTTP_HOST=127.0.0.1 Bind address
REM   QUILL_AUTH_TOKEN=secret   Bearer token for authentication
REM   NOTES_VAULT_PATH=C:\path  Vault path override

setlocal

set SCRIPT_DIR=%~dp0
set QUILL_HTTP_ENABLED=true

echo Starting quill-mcp in HTTP mode...
echo   Stdio transport: active (for local MCP clients)
echo   HTTP transport:  active on %QUILL_HTTP_HOST:~0,127.0.0.1%:%QUILL_HTTP_PORT:~0,3000%

if defined QUILL_AUTH_TOKEN (
    echo   Authentication:  enabled ^(Bearer token^)
) else (
    echo   Authentication:  disabled ^(set QUILL_AUTH_TOKEN to enable^)
)

node "%SCRIPT_DIR%dist\index.js" %*

endlocal
