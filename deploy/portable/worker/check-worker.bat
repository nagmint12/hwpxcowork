@echo off
rem 연결 점검만 — 로그인·서버 주소·토큰·필수 도구를 확인하고 끝낸다(요청 선점·모델 호출 없음).
call "%~dp0start-worker.bat" --check %*
