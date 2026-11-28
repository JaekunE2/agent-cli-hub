"""Add Korean notes and recommendations to the latest collected report."""
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from scraper import DATA_DIR, REPORTS_DIR, SourceStatus, TrendItem, render_html

PROMPT = (
    "입력 항목은 참고 자료입니다. 외부 도구를 사용하지 마세요. "
    "오늘의 AI 기술 동향을 한국어로 2~3문장 요약하고 실무자가 볼 만한 항목을 최대 6개 추천하세요. "
    "needs_note가 true인 모든 항목에 한국어 첨언을 한 문장씩 쓰세요. "
    "제목이나 설명에서 알 수 있는 핵심만 쓰고, 근거 없는 기능이나 수치를 추가하지 마세요. "
    "notes는 입력 id를 문자열 키로 사용하고, needs_note가 false인 항목은 제외하세요. "
    'JSON 객체 하나만 반환하세요. 형식은 {"overview":"","picks":[{"id":1,"reason":""}],'
    '"notes":{"1":"한국어 첨언"}}입니다.'
)


def has_korean(text):
    letters = sum(ch.isalpha() for ch in text)
    hangul = len(re.findall(r"[가-힣]", text))
    return hangul >= 2 and hangul * 10 >= letters


def korean_text(value):
    return isinstance(value, str) and bool(re.search(r"[가-힣]", value))


def report_data(items, result, required):
    overview, picks, notes = result["overview"], result["picks"], result["notes"]
    if not korean_text(overview):
        raise ValueError("한국어 브리핑이 비어 있습니다.")
    ids = [pick["id"] for pick in picks]
    if len(ids) != min(6, len(items)) or len(set(ids)) != len(ids):
        raise ValueError("추천 항목 수가 올바르지 않습니다.")
    top_picks = []
    for pick in picks:
        i, reason = pick["id"], pick["reason"]
        if type(i) is not int or not 1 <= i <= len(items) or not korean_text(reason):
            raise ValueError("추천 항목이나 추천 이유를 확인할 수 없습니다.")
        item = items[i - 1]
        url = item.url if urlsplit(item.url).scheme in {"http", "https"} else "#"
        top_picks.append({"title": item.title, "url": url, "category": item.source_name,
                          "reason": reason.strip(), "proof": item.metrics})
    if set(notes) != required or any(not korean_text(note) for note in notes.values()):
        raise ValueError(f"한국어 첨언 범위가 올바르지 않습니다. 대상 {len(required)}건 중 {len(required & set(notes))}건 응답")
    curated = {"top_picks": top_picks, "themes": [{"theme": "오늘의 동향", "detail": overview.strip()}]}
    ko_notes = {items[int(i) - 1].url: note.strip() for i, note in notes.items()}
    return curated, ko_notes


def write_text(path, text):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)


def request_summary(payload):
    cli = shutil.which("codex")
    if cli is None:
        raise RuntimeError("PATH에 Codex CLI가 없습니다. 설치하고 로그인해 주세요.")
    with tempfile.TemporaryDirectory(prefix="trend-summary-") as work:
        subprocess.run(
            [cli, "exec", "--skip-git-repo-check", "--ephemeral", "--disable", "hooks",
             "--json", "--color", "never", "-s", "read-only", "-o", "answer.json", "-"],
            input=PROMPT + "\n\n" + json.dumps(payload, ensure_ascii=False),
            encoding="utf-8", cwd=work, stdout=subprocess.DEVNULL, check=True, timeout=200,
        )
        raw = (Path(work) / "answer.json").read_text(encoding="utf-8").strip()
    raw = re.sub(r"^\s*\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60\s*$", "", raw)
    return json.loads(raw)


def main():
    files = [p for p in DATA_DIR.glob("*.json") if re.fullmatch(r"\d{4}-\d{2}-\d{2}", p.stem)]
    if not files:
        raise ValueError("먼저 동향을 수집하세요.")
    source = max(files, key=lambda p: p.stem)
    data = json.loads(source.read_text(encoding="utf-8"))
    items = [TrendItem(**item) for item in data["items"]]
    if not items:
        raise ValueError("요약할 항목이 없습니다.")
    statuses = [SourceStatus(**status) for status in data["statuses"]]
    payload = [
        {"id": i, "title": item.title, "summary": item.summary[:290],
         "needs_note": not has_korean(item.summary or item.title)}
        for i, item in enumerate(items, 1)
    ]
    required = {str(entry["id"]) for entry in payload if entry["needs_note"]}
    print(f"전체 {len(items)}건 중 {len(required)}건의 한국어 첨언과 핵심 추천을 생성하고 있습니다.", flush=True)
    curated, ko_notes = report_data(items, request_summary(payload), required)
    report = render_html(data["generated_at"], statuses, items, data.get("previous_run"), curated, ko_notes)
    REPORTS_DIR.mkdir(exist_ok=True)
    for suffix, contents in [("ko", ko_notes), ("curated", curated)]:
        write_text(DATA_DIR / f"{source.stem}-{suffix}.json", json.dumps(contents, ensure_ascii=False, indent=2))
    output = REPORTS_DIR / f"{source.stem}.html"
    write_text(output, report)
    print(f"한국어 첨언 {len(required)}건과 추천 {len(curated['top_picks'])}건을 {output.name}에 저장했습니다.")


if __name__ == "__main__":
    main()

