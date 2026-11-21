; Run before uninstallOldVersion and before extracting the replacement files.
; The same check also guards the uninstaller shipped with this build.
!macro customCheckAppRunning
  InitPluginsDir
  File "/oname=$PLUGINSDIR\stop-desktop.ps1" "${BUILD_RESOURCES_DIR}\stop-desktop.ps1"
  ReadRegStr $R1 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $R1 == ""
    StrCpy $R1 "$INSTDIR"
  ${EndIf}
  StrCpy $R2 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\stop-desktop.ps1" -Destination "$INSTDIR" -Previous "$R1"'
  cowork_check:
    nsExec::Exec '$R2 -Action Check'
    Pop $R0
    StrCmp $R0 0 cowork_done
    StrCmp $R0 10 0 cowork_blocked
    IfSilent cowork_close
    MessageBox MB_OKCANCEL|MB_ICONINFORMATION "실행 중인 Hwpx Cowork 앱과 이 설치에서 시작한 서버를 먼저 종료합니다.$\r$\n$\r$\n[확인]을 누른 뒤, 편집 중인 문서에 저장 확인이 나타나면 앱에서 마무리해 주세요." IDOK cowork_close IDCANCEL cowork_cancel
  cowork_close:
    DetailPrint "앱과 서버가 저장을 마치고 종료될 때까지 기다리는 중…"
    nsExec::Exec '$R2 -Action Close'
    Pop $R0
    StrCmp $R0 0 cowork_done
  cowork_blocked:
    IfSilent cowork_cancel
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "앱과 서버의 종료를 확인할 수 없습니다. 편집 중인 내용을 저장하고 실행 중인 Hwpx Cowork를 닫은 뒤 [다시 시도]를 누르세요." IDRETRY cowork_check
  cowork_cancel:
    SetErrorLevel 1602
    Quit
  cowork_done:
!macroend
