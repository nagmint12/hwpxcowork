@echo off
rem 시작 스크립트가 CALL 로 부른다: 쓸 수 있는 Node.js(22 이상)를 NODE 에 넣는다. 이미 설치된 Node 를 먼저 쓰고,
rem 없으면 공식 Node 를 이 폴더 runtime\ 에 내려받을지 묻는다(HWPX_COWORK_INSTALL_NODE=1 이면 묻지 않고 받음). 실패하면 종료 코드 1.
call "%~dp0find-node.cmd"
if defined NODE exit /b 0
echo.
if defined NODE_OLD (
  echo  이 PC 의 Node.js 는 %NODE_OLD%판이라 쓸 수 없습니다^(22 이상 필요^).
) else (
  echo  이 PC 에 Node.js 22 이상이 없습니다.
)
if "%HWPX_COWORK_INSTALL_NODE%"=="1" goto install
set "HWPX_ANSWER="
set /p "HWPX_ANSWER= 공식 Node.js 를 이 폴더의 runtime\ 에 내려받을까요? 약 30 MB, 관리자 권한 불필요 [Y/N]: "
if /i "%HWPX_ANSWER%"=="Y" goto install
echo  https://nodejs.org 에서 LTS 를 설치하거나 install-node.bat 를 실행한 뒤 다시 켜세요.
exit /b 1
:install
call "%~dp0..\..\install-node.bat" --called
if errorlevel 1 exit /b 1
call "%~dp0find-node.cmd"
if defined NODE exit /b 0
echo  [오류] 내려받은 Node.js 를 찾지 못했습니다.
exit /b 1
