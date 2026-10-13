; ------------------------------------------------------------------
; Incluído pelo electron-builder no instalador NSIS (build/installer.nsh).
;
; Antes de instalar ou atualizar, guarda uma cópia da configuração do
; usuário (listas, favoritos, histórico, ajustes). O instalador não apaga
; %APPDATA%\BishopTV, mas, se algo der errado na atualização, a cópia em
; %APPDATA%\BishopTV\backups permite recuperar tudo — inclusive pelo botão
; "Importar" em Configurações.
; ------------------------------------------------------------------

!macro customInit
  ; O Electron guarda os dados sempre por usuário, mesmo em instalação "para todos".
  ${if} $installMode == "all"
    SetShellVarContext current
  ${endif}

  ${if} ${FileExists} "$APPDATA\BishopTV\bishoptv-store.json"
    CreateDirectory "$APPDATA\BishopTV\backups"
    CopyFiles /SILENT "$APPDATA\BishopTV\bishoptv-store.json" "$APPDATA\BishopTV\backups\store-antes-da-${VERSION}.json"
  ${endif}

  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}
!macroend
