# AI 동향파악

Windows용 앱입니다. Python 3.12와 인터넷 연결이 필요하며, 한국어 요약에는 로그인된 Codex CLI가 필요합니다. 설치 폴더에 수집 데이터와 리포트가 저장됩니다.

1. ZIP을 쓰기 가능한 폴더에 풉니다.
2. 해당 폴더에서 `powershell -NoProfile -File .\setup.ps1`을 실행합니다. 의존성은 이 폴더의 `.venv`에 설치됩니다.
3. 허브에서 **Apps → 앱 추가 → 폴더에서 app.json 가져오기**를 눌러 압축을 푼 폴더를 등록합니다. 앱에서 **금일 동향 수집 실행 → 한국어 요약 생성**을 누르면 결과 리포트가 열립니다.

허브 없이 로컬에서 실행할 때는 설치 폴더에서 아래 순서로 실행한 뒤 `산출물` 폴더의 날짜별 HTML을 엽니다.

```powershell
.\.venv\Scripts\python.exe -B .\scraper.py
.\.venv\Scripts\python.exe -B .\summarize.py
```
