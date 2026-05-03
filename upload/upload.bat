@echo off
setlocal EnableDelayedExpansion

set "UIDFILE=C:\ResumeSender\user_id.txt"
set "ARG1=%~1"
set "ARG2=%~2"

if not "!ARG2!"=="" (
  set "RUID=!ARG1!"
  set "UFILE=!ARG2!"
  goto :do_upload
)

set "UFILE=!ARG1!"
set "RUID="
if exist "%UIDFILE%" (
  for /f "usebackq tokens=* delims=" %%a in ("%UIDFILE%") do (
    set "RUID=%%a"
    goto :gotuid
  )
)
:gotuid
set "RUID=!RUID: =!"
if "!RUID!"=="" (
  echo Missing User ID. Set User ID in the Resume Sender extension ^(syncs to %UIDFILE%^) or use a send^(id^) menu that passes the id.
  exit /b 1
)

:do_upload
if "!UFILE!"=="" (
  echo Missing file path.
  exit /b 1
)

echo Uploading file: !UFILE!
curl -X POST -F "resume_file=@!UFILE!" -F "user_id=!RUID!" "http://localhost:8787/resume"
exit /b
