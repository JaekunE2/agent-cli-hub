"""LLM & AI 신기술 동향 스크래퍼 (scrapling 기반).

사용법:
    .venv\\Scripts\\python.exe scraper.py
"""

from __future__ import annotations

import html
import json
import os
import re
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import yaml


def _ensure_ascii_ca_bundle() -> None:
    """Windows 한글 경로에서 curl_cffi가 cacert.pem을 못 읽는 문제(curl error 77) 우회."""
    if os.environ.get("CURL_CA_BUNDLE"):
        return
    git_ca = Path(r"C:\Program Files\Git\mingw64\etc\ssl\certs\ca-bundle.crt")
    if git_ca.exists():
        os.environ["CURL_CA_BUNDLE"] = str(git_ca)


_ensure_ascii_ca_bundle()

from scrapling.fetchers import Fetcher  # noqa: E402


BASE_DIR = Path(__file__).resolve().parent
SOURCES_PATH = BASE_DIR / "sources.yaml"
DATA_DIR = BASE_DIR / "data"
REPORTS_DIR = BASE_DIR / "산출물"


@dataclass
class TrendItem:
    source_id: str
    source_name: str
    category: str
    title: str
    url: str
    summary: str = ""
    metrics: str = ""
    extra_url: str = ""
    matched_keywords: list[str] = field(default_factory=list)
    is_new: bool = True


@dataclass
class SourceStatus:
    source_id: str
    source_name: str
    ok: bool
    fetched_count: int
    kept_count: int
    elapsed_ms: int
    error: str = ""


def load_config(path: Path) -> tuple[list[str], list[dict[str, Any]]]:
    with path.open("r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    keywords = [kw.lower() for kw in cfg.get("keywords", {}).get("include", [])]
    sources = cfg.get("sources", [])
    return keywords, sources


def match_keywords(text: str, keywords: list[str]) -> list[str]:
    lowered = text.lower()
    matched: list[str] = []
    for kw in keywords:
        if re.search(r"^[a-z0-9\-]+$", kw):
            if re.search(rf"\b{re.escape(kw)}\b", lowered):
                matched.append(kw)
        else:
            if kw in lowered:
                matched.append(kw)
    return matched


def clean_text(text: str | None) -> str:
    if not text:
        return ""
    return re.sub(r"\s+", " ", text).strip()


def fetch_page(url: str) -> Any:
    resp = Fetcher.get(url, timeout=15, retries=1)
    if resp.status != 200:
        raise RuntimeError(f"HTTP {resp.status} for {url}")
    return resp


def parse_geeknews(src: dict[str, Any]) -> list[TrendItem]:
    resp = fetch_page(src["url"])
    items: list[TrendItem] = []
    for row in resp.css("div.topic_row"):
        title = clean_text("".join(row.css("div.topictitle a ::text").getall()))
        href = row.css("div.topictitle a::attr(href)").get() or ""
        desc = clean_text(row.css("div.topicdesc a::text").get())
        info = clean_text(" ".join(row.css("div.topicinfo ::text").getall()))
        topic_links = row.css("div.topicinfo a::attr(href)").getall()
        discussion = next((l for l in topic_links if "topic?id=" in l), "")
        extra = f"https://news.hada.io/{discussion}" if discussion else ""
        if href.startswith("topic?"):
            href = f"https://news.hada.io/{href}"
        if title:
            items.append(
                TrendItem(
                    source_id=src["id"],
                    source_name=src["name"],
                    category=src["category"],
                    title=title,
                    url=href,
                    summary=desc,
                    metrics=info.replace("댓글과 토론", "").strip(" |"),
                    extra_url=extra,
                )
            )
    return items


def parse_hackernews(src: dict[str, Any]) -> list[TrendItem]:
    resp = fetch_page(src["url"])
    items: list[TrendItem] = []
    athings = resp.css("tr.athing")
    for row in athings:
        item_id = row.attrib.get("id", "")
        title = clean_text(row.css("span.titleline > a::text").get())
        href = row.css("span.titleline > a::attr(href)").get() or ""
        if href.startswith("item?"):
            href = f"https://news.ycombinator.com/{href}"
        subtext = resp.css(f"span#score_{item_id}::text").get() or ""
        hn_url = f"https://news.ycombinator.com/item?id={item_id}" if item_id else ""
        if title:
            items.append(
                TrendItem(
                    source_id=src["id"],
                    source_name=src["name"],
                    category=src["category"],
                    title=title,
                    url=href,
                    metrics=clean_text(subtext),
                    extra_url=hn_url,
                )
            )
    return items


def parse_github_trending(src: dict[str, Any]) -> list[TrendItem]:
    seen: set[str] = set()
    items: list[TrendItem] = []
    for url in src.get("urls", []):
        resp = fetch_page(url)
        for row in resp.css("article.Box-row"):
            href = row.css("h2 a::attr(href)").get() or ""
            repo_name = href.strip("/")
            if not repo_name or repo_name in seen:
                continue
            seen.add(repo_name)
            desc = clean_text(row.css("p::text").get())
            meta_parts = [clean_text(t) for t in row.css("div.f6 ::text").getall()]
            meta_parts = [p for p in meta_parts if p and p != "Built by"]
            items.append(
                TrendItem(
                    source_id=src["id"],
                    source_name=src["name"],
                    category=src["category"],
                    title=repo_name,
                    url=f"https://github.com/{repo_name}",
                    summary=desc,
                    metrics=" · ".join(meta_parts[:4]),
                )
            )
    return items


def parse_gitlab_api(src: dict[str, Any]) -> list[TrendItem]:
    items: list[TrendItem] = []
    for url in src.get("urls", []):
        resp = fetch_page(url)
        data = json.loads(resp.body.decode("utf-8"))
        for proj in data:
            items.append(
                TrendItem(
                    source_id=src["id"],
                    source_name=src["name"],
                    category=src["category"],
                    title=proj.get("path_with_namespace", ""),
                    url=proj.get("web_url", ""),
                    summary=clean_text(proj.get("description")),
                    metrics=f"★ {proj.get('star_count', 0)} · updated {str(proj.get('last_activity_at', ''))[:10]}",
                )
            )
    return items


def parse_hf_papers(src: dict[str, Any]) -> list[TrendItem]:
    resp = fetch_page(src["url"])
    items: list[TrendItem] = []
    for art in resp.css("article"):
        title = clean_text(art.css("h3 a::text").get())
        href = art.css("h3 a::attr(href)").get() or ""
        if href.startswith("/"):
            href = f"https://huggingface.co{href}"
        # Upvote 숫자 추출 시도
        nums = [clean_text(t) for t in art.css("div ::text").getall()]
        upvote = next((n for n in nums if n.isdigit()), "")
        if title:
            items.append(
                TrendItem(
                    source_id=src["id"],
                    source_name=src["name"],
                    category=src["category"],
                    title=title,
                    url=href,
                    metrics=f"▲ {upvote} upvotes" if upvote else "",
                )
            )
    return items


def parse_hf_models(src: dict[str, Any]) -> list[TrendItem]:
    resp = fetch_page(src["url"])
    items: list[TrendItem] = []
    for card in resp.css("article.overview-card-wrapper")[:15]:
        href = card.css("a::attr(href)").get() or ""
        model_id = clean_text(" ".join(card.css("h4::text").getall())) or href.strip("/")
        meta = clean_text(" ".join(card.css("div.mr-1 ::text, span.truncate ::text").getall()))
        if href.startswith("/"):
            href = f"https://huggingface.co{href}"
        if model_id:
            items.append(
                TrendItem(
                    source_id=src["id"],
                    source_name=src["name"],
                    category=src["category"],
                    title=model_id,
                    url=href,
                    metrics=meta[:80],
                )
            )
    return items


def parse_arxiv(src: dict[str, Any]) -> list[TrendItem]:
    resp = fetch_page(src["url"])
    dts = resp.css("dl#articles dt")
    dds = resp.css("dl#articles dd")
    items: list[TrendItem] = []
    for dt, dd in zip(dts[:30], dds[:30]):
        abs_href = dt.css("a[title='Abstract']::attr(href)").get() or ""
        title_raw = clean_text("".join(dd.css("div.list-title::text").getall()))
        title = re.sub(r"^Title:\s*", "", title_raw)
        authors = clean_text(" ".join(dd.css("div.list-authors a::text").getall()[:3]))
        subjects = clean_text("".join(dd.css("div.list-subjects::text").getall()))
        if title and abs_href:
            abs_url = f"https://arxiv.org{abs_href}" if abs_href.startswith("/") else abs_href
            items.append(
                TrendItem(
                    source_id=src["id"],
                    source_name=src["name"],
                    category=src["category"],
                    title=title,
                    url=abs_url,
                    summary=f"Authors: {authors}" if authors else "",
                    metrics=subjects[:60],
                )
            )
    return items


def enrich_arxiv_abstracts(items: list[TrendItem], limit: int = 8) -> None:
    """필터링된 arXiv 논문의 초록(abstract)을 추가 수집해 판단 근거를 보강합니다."""
    count = 0
    for it in items:
        if it.source_id != "arxiv_cl" or count >= limit:
            continue
        try:
            resp = fetch_page(it.url)
            abs_text = clean_text("".join(resp.css("blockquote.abstract ::text").getall()))
            abs_text = re.sub(r"^Abstract:\s*", "", abs_text)
            if abs_text:
                it.summary = f"{it.summary} | {abs_text[:280]}" if it.summary else abs_text[:280]
            count += 1
        except Exception:
            continue


PARSERS = {
    "geeknews": parse_geeknews,
    "hackernews": parse_hackernews,
    "github_trending": parse_github_trending,
    "gitlab_llm": parse_gitlab_api,
    "hf_daily_papers": parse_hf_papers,
    "hf_trending_models": parse_hf_models,
    "arxiv_cl": parse_arxiv,
}


def load_previous_urls(data_dir: Path, current_date_slug: str) -> tuple[str | None, set[str]]:
    """이전 실행일 중 가장 최근 JSON 파일을 찾아 이미 본 URL 집합을 반환합니다."""
    candidates = sorted(
        p for p in data_dir.glob("*.json") if p.stem < current_date_slug
    )
    if not candidates:
        return None, set()
    latest = candidates[-1]
    try:
        payload = json.loads(latest.read_text(encoding="utf-8"))
        urls = {it.get("url", "") for it in payload.get("items", []) if it.get("url")}
        return latest.stem, urls
    except Exception:
        return None, set()


def render_markdown(
    run_ts: str,
    statuses: list[SourceStatus],
    items: list[TrendItem],
    prev_date: str | None = None,
) -> str:
    new_count = sum(1 for it in items if it.is_new)
    compare_line = (
        f"- 직전 수집(`{prev_date}`) 대비 신규 항목: **{new_count}건** / 전체 **{len(items)}건**"
        if prev_date
        else f"- 총 수집 항목(필터링 후): **{len(items)}건** (첫 실행)"
    )
    lines: list[str] = [
        f"# LLM & AI 기술 동향 리포트 ({run_ts[:10]})",
        "",
        f"- 수집 시각: `{run_ts}`",
        compare_line,
        "",
        "## 1. 수집 상태 요약",
        "",
        "| 출처 | 상태 | 전체 수집 | 필터 후 | 소요 시간 | 비고 |",
        "|---|---|---:|---:|---:|---|",
    ]
    for st in statuses:
        badge = "OK" if st.ok else "FAIL"
        note = st.error if st.error else "-"
        lines.append(
            f"| {st.source_name} | {badge} | {st.fetched_count} | {st.kept_count} | {st.elapsed_ms} ms | {note} |"
        )

    cat_labels = {
        "community": "2. 커뮤니티 & 개발자 화제 (GeekNews / HN)",
        "opensource": "3. 오픈소스 트렌딩 (GitHub / GitLab)",
        "research": "4. 최신 논문 (Hugging Face Papers / arXiv)",
        "models": "5. 트렌딩 모델 (Hugging Face Models)",
    }

    for cat_key, heading in cat_labels.items():
        cat_items = [it for it in items if it.category == cat_key]
        lines.extend(["", f"## {heading}", ""])
        if not cat_items:
            lines.append("- 해당 조건에 맞는 신규 항목이 없습니다.")
            continue
        for idx, it in enumerate(cat_items, 1):
            new_badge = "`NEW` " if (prev_date and it.is_new) else ""
            kw_str = f" `[{', '.join(it.matched_keywords[:4])}]`" if it.matched_keywords else ""
            metric_str = f" — *{it.metrics}*" if it.metrics else ""
            lines.append(f"{idx}. {new_badge}**[{it.title}]({it.url})** ({it.source_name}){metric_str}{kw_str}")
            if it.summary:
                lines.append(f"   - {it.summary[:180]}")
            if it.extra_url:
                lines.append(f"   - 토론/원글: {it.extra_url}")

    return "\n".join(lines) + "\n"


def load_curated_summary(data_dir: Path, date_slug: str) -> dict[str, Any] | None:
    curated_path = data_dir / f"{date_slug}-curated.json"
    if not curated_path.exists():
        return None
    try:
        return json.loads(curated_path.read_text(encoding="utf-8"))
    except Exception:
        return None


def load_ko_notes(data_dir: Path, date_slug: str) -> dict[str, str]:
    ko_path = data_dir / f"{date_slug}-ko.json"
    if not ko_path.exists():
        return {}
    try:
        data = json.loads(ko_path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


PLATFORM_DESCRIPTIONS = {
    "all": "수집된 모든 플랫폼의 AI/LLM 동향을 최신순·출처별로 한 번에 확인합니다.",
    "geeknews": "GeekNews (긱뉴스) — 국내 개발자 커뮤니티가 주목하는 최신 AI·기술 뉴스와 한국어 요약/토론입니다.",
    "hackernews": "Hacker News — 글로벌 엔지니어·창업자 커뮤니티의 인기 기술 글입니다. (points가 높을수록 화제성이 큽니다.)",
    "github_trending": "GitHub Trending — 오늘 하루 Star가 급증한 오픈소스 프로젝트입니다. (stars today로 급상승 정도를 판단하세요.)",
    "gitlab_llm": "GitLab Public Projects — 최근 활동이 있는 GitLab 공개 LLM/AI 프로젝트입니다. (CI/CD, 폐쇄망, 실무 도구 비중이 높습니다.)",
    "hf_daily_papers": "Hugging Face Daily Papers — AI 연구자·개발자들이 매일 추천(Upvote)하는 최신 논문입니다.",
    "hf_trending_models": "Hugging Face Trending Models — 현재 다운로드와 좋아요가 급증하고 있는 공개 AI 모델입니다.",
    "arxiv_cl": "arXiv cs.CL — 자연어처리·LLM 분야의 최신 프리프린트 논문과 초록입니다.",
}


def render_html(
    run_ts: str,
    statuses: list[SourceStatus],
    items: list[TrendItem],
    prev_date: str | None = None,
    curated: dict[str, Any] | None = None,
    ko_notes: dict[str, str] | None = None,
) -> str:
    esc = html.escape
    new_count = sum(1 for it in items if it.is_new)
    compare_badge = (
        f"직전 수집({esc(prev_date)}) 대비 신규 {new_count}건 / 전체 {len(items)}건"
        if prev_date
        else f"총 {len(items)}건 수집 (첫 실행)"
    )

    cat_meta = {
        "community": ("커뮤니티 & 개발자 화제", "실무 개발자들이 직접 공유·토론하는 최신 이슈와 활용 사례입니다."),
        "opensource": ("오픈소스 트렌딩 (GitHub / GitLab)", "최근 Star가 급증하거나 활발히 개발 중인 AI/LLM 도구·프레임워크입니다."),
        "research": ("최신 논문 (Hugging Face / arXiv)", "주목받는 신규 아키텍처, 에이전트 연구 및 추론 최적화 논문입니다."),
        "models": ("트렌딩 모델 (Hugging Face)", "최근 다운로드와 좋아요가 빠르게 늘고 있는 공개 모델입니다."),
    }

    # 상태 배지 HTML
    status_rows = []
    for st in statuses:
        cls = "ok" if st.ok else "fail"
        label = "정상" if st.ok else "비활성"
        note = esc(st.error) if st.error else "-"
        status_rows.append(
            f"<tr><td>{esc(st.source_name)}</td><td><span class='badge {cls}'>{label}</span></td>"
            f"<td class='num'>{st.fetched_count}</td><td class='num'>{st.kept_count}</td>"
            f"<td class='num'>{st.elapsed_ms} ms</td><td class='muted'>{note}</td></tr>"
        )

    # 큐레이션(핵심 추천 & 한국어 브리핑) 섹션
    curated_html = ""
    if curated:
        top_cards = []
        for idx, rec in enumerate(curated.get("top_picks", []), 1):
            top_cards.append(
                f"""<div class="pick-card">
                    <div class="pick-rank">TOP {idx} · {esc(rec.get("category", ""))}</div>
                    <h3><a href="{esc(rec.get("url", "#"))}" target="_blank" rel="noopener">{esc(rec.get("title", ""))}</a></h3>
                    <div class="pick-proof">{esc(rec.get("proof", ""))}</div>
                    <p>{esc(rec.get("reason", ""))}</p>
                </div>"""
            )
        trend_bullets = "".join(
            f"<li><strong>{esc(t.get('theme', ''))}:</strong> {esc(t.get('detail', ''))}</li>"
            for t in curated.get("themes", [])
        )
        curated_html = f"""
        <section class="card curated-section">
            <h2>오늘의 핵심 추천 &amp; 한국어 브리핑</h2>
            <p class="section-desc">수집된 항목 중 실무 가치와 커뮤니티 반응을 기준으로 선별·요약했습니다.</p>
            <div class="pick-grid">{"".join(top_cards)}</div>
            <div class="themes-box">
                <h3>한눈에 보는 오늘의 기술 흐름</h3>
                <ul>{trend_bullets}</ul>
            </div>
        </section>
        """

    # 카테고리별 아이템 카드
    ko_notes = ko_notes or {}
    item_cards = []
    for it in items:
        cat_label = cat_meta.get(it.category, (it.category, ""))[0]
        new_tag = "<span class='tag new'>NEW</span>" if (prev_date and it.is_new) else ""
        kw_tags = "".join(f"<span class='tag kw'>{esc(k)}</span>" for k in it.matched_keywords[:4])
        ko_text = ko_notes.get(it.url, "")
        ko_html = f"<div class='ko-note'><strong>한글 요약:</strong> {esc(ko_text)}</div>" if ko_text else ""
        summary_html = f"<p class='item-summary'>{esc(it.summary[:240])}</p>" if it.summary else ""
        extra_html = (
            f" · <a href='{esc(it.extra_url)}' target='_blank' rel='noopener'>토론/원글 보기</a>"
            if it.extra_url
            else ""
        )
        metric_html = f"<span class='metric'>{esc(it.metrics)}</span>" if it.metrics else ""
        search_blob = esc(f"{it.title} {ko_text} {it.summary} {it.source_name} {' '.join(it.matched_keywords)}".lower())

        item_cards.append(
            f"""<article class="item-card" data-category="{esc(it.category)}" data-source="{esc(it.source_id)}" data-new="{'1' if it.is_new else '0'}" data-search="{search_blob}">
                <div class="item-top">
                    <span class="tag src">{esc(it.source_name)}</span>
                    <span class="tag cat">{esc(cat_label)}</span>
                    {new_tag}{kw_tags}
                </div>
                <h3 class="item-title"><a href="{esc(it.url)}" target="_blank" rel="noopener">{esc(it.title)}</a></h3>
                {ko_html}
                {summary_html}
                <div class="item-meta">{metric_html}{extra_html}</div>
            </article>"""
        )

    platform_tabs = [f'<button class="tab-btn active" data-source="all">전체 ({len(items)})</button>']
    short_names = {
        "geeknews": "GeekNews",
        "hackernews": "Hacker News",
        "github_trending": "GitHub",
        "gitlab_llm": "GitLab",
        "hf_daily_papers": "HF Papers",
        "hf_trending_models": "HF Models",
        "arxiv_cl": "arXiv",
    }
    for st in statuses:
        if not st.ok or st.kept_count == 0:
            continue
        label = short_names.get(st.source_id, st.source_name)
        platform_tabs.append(
            f'<button class="tab-btn" data-source="{esc(st.source_id)}">{esc(label)} ({st.kept_count})</button>'
        )

    return f"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>LLM &amp; AI 기술 동향 리포트 ({esc(run_ts[:10])})</title>
<style>
  :root {{
    --bg: #f6f8fb; --card: #ffffff; --text: #18212f; --muted: #5a667a;
    --border: #e2e8f0; --accent: #2563eb; --accent-soft: #eff6ff;
    --ok-bg: #dcfce7; --ok-fg: #166534; --fail-bg: #fee2e2; --fail-fg: #991b1b;
    --new-bg: #fef3c7; --new-fg: #92400e;
  }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; font-family: "Pretendard", "Malgun Gothic", -apple-system, BlinkMacSystemFont, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }}
  .container {{ max-width: 1120px; margin: 0 auto; padding: 28px 20px 60px; }}
  header.hero {{ background: linear-gradient(135deg, #1e293b, #0f172a); color: #f8fafc; padding: 28px 30px; border-radius: 16px; margin-bottom: 24px; }}
  header.hero h1 {{ margin: 0 0 8px; font-size: 1.65rem; }}
  .hero-meta {{ display: flex; flex-wrap: wrap; gap: 12px; font-size: 0.92rem; color: #cbd5e1; }}
  .hero-pill {{ background: rgba(255,255,255,0.12); padding: 4px 12px; border-radius: 999px; }}
  .card {{ background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 22px 24px; margin-bottom: 22px; box-shadow: 0 1px 3px rgba(15,23,42,0.04); }}
  h2 {{ margin: 0 0 8px; font-size: 1.25rem; }}
  .section-desc {{ margin: 0 0 16px; color: var(--muted); font-size: 0.92rem; }}
  .pick-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; margin-bottom: 18px; }}
  .pick-card {{ border: 1px solid var(--border); border-radius: 12px; padding: 16px; background: #fafcff; }}
  .pick-rank {{ font-size: 0.78rem; font-weight: 700; color: var(--accent); text-transform: uppercase; margin-bottom: 6px; }}
  .pick-card h3 {{ margin: 0 0 6px; font-size: 1.04rem; }}
  .pick-card h3 a {{ color: var(--text); text-decoration: none; }}
  .pick-card h3 a:hover {{ color: var(--accent); text-decoration: underline; }}
  .pick-proof {{ font-size: 0.82rem; color: var(--ok-fg); background: var(--ok-bg); display: inline-block; padding: 2px 8px; border-radius: 6px; margin-bottom: 8px; }}
  .pick-card p {{ margin: 0; font-size: 0.9rem; color: #334155; }}
  .themes-box {{ background: var(--accent-soft); border-radius: 10px; padding: 14px 18px; }}
  .themes-box h3 {{ margin: 0 0 8px; font-size: 1rem; color: #1e3a8a; }}
  .themes-box ul {{ margin: 0; padding-left: 18px; font-size: 0.92rem; }}
  .themes-box li {{ margin-bottom: 6px; }}
  .controls {{ display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 16px; }}
  .tab-btn {{ border: 1px solid var(--border); background: #fff; color: var(--text); padding: 7px 14px; border-radius: 999px; cursor: pointer; font-size: 0.88rem; font-weight: 600; }}
  .tab-btn.active {{ background: var(--accent); color: #fff; border-color: var(--accent); }}
  .search-input {{ flex: 1; min-width: 220px; padding: 8px 14px; border: 1px solid var(--border); border-radius: 999px; font-size: 0.9rem; }}
  .new-toggle {{ display: flex; align-items: center; gap: 6px; font-size: 0.88rem; color: var(--text); cursor: pointer; }}
  .items-list {{ display: grid; gap: 12px; }}
  .item-card {{ background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; }}
  .item-top {{ display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }}
  .tag {{ font-size: 0.76rem; padding: 2px 8px; border-radius: 6px; font-weight: 600; }}
  .tag.src {{ background: #e2e8f0; color: #334155; }}
  .tag.cat {{ background: var(--accent-soft); color: var(--accent); }}
  .tag.new {{ background: var(--new-bg); color: var(--new-fg); }}
  .tag.kw {{ background: #f1f5f9; color: #475569; }}
  .item-title {{ margin: 0 0 6px; font-size: 1.05rem; }}
  .item-title a {{ color: var(--text); text-decoration: none; }}
  .item-title a:hover {{ color: var(--accent); text-decoration: underline; }}
  .ko-note {{ background: #f0f7ff; border-left: 3px solid var(--accent); padding: 8px 12px; border-radius: 6px; margin: 6px 0 8px; font-size: 0.91rem; color: #1e293b; }}
  .platform-banner {{ background: var(--card); border: 1px solid var(--border); border-left: 4px solid var(--accent); border-radius: 10px; padding: 10px 14px; margin-bottom: 14px; font-size: 0.9rem; color: #334155; }}
  .item-summary {{ margin: 0 0 8px; font-size: 0.85rem; color: var(--muted); }}
  .item-meta {{ font-size: 0.83rem; color: var(--muted); }}
  .item-meta a {{ color: var(--accent); text-decoration: none; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 0.88rem; }}
  th, td {{ padding: 9px 10px; border-bottom: 1px solid var(--border); text-align: left; }}
  th.num, td.num {{ text-align: right; }}
  .badge {{ padding: 2px 8px; border-radius: 999px; font-size: 0.78rem; font-weight: 700; }}
  .badge.ok {{ background: var(--ok-bg); color: var(--ok-fg); }}
  .badge.fail {{ background: var(--fail-bg); color: var(--fail-fg); }}
  .muted {{ color: var(--muted); }}
  details summary {{ cursor: pointer; font-weight: 700; }}
</style>
</head>
<body>
<div class="container">
  <header class="hero">
    <h1>LLM &amp; AI 신기술 동향 리포트 ({esc(run_ts[:10])})</h1>
    <div class="hero-meta">
      <span class="hero-pill">수집 시각: {esc(run_ts)}</span>
      <span class="hero-pill">{compare_badge}</span>
    </div>
  </header>

  {curated_html}

  <section class="card">
    <details>
      <summary>수집 출처별 동작 상태 보기 ({sum(1 for s in statuses if s.ok)}/{len(statuses)} 정상)</summary>
      <div style="margin-top:12px; overflow-x:auto;">
        <table>
          <thead><tr><th>출처</th><th>상태</th><th class="num">전체 수집</th><th class="num">필터 후</th><th class="num">소요 시간</th><th>비고</th></tr></thead>
          <tbody>{"".join(status_rows)}</tbody>
        </table>
      </div>
    </details>
  </section>

  <section>
    <div class="controls">
      {"".join(platform_tabs)}
      <input id="searchBox" class="search-input" type="search" placeholder="키워드·제목·출처 검색..." />
      <label class="new-toggle"><input id="newOnly" type="checkbox" /> NEW만 보기</label>
    </div>
    <div id="platformBanner" class="platform-banner">{esc(PLATFORM_DESCRIPTIONS["all"])}</div>
    <div id="itemsList" class="items-list">
      {"".join(item_cards)}
    </div>
  </section>
</div>
<script>
  const platformDescs = {json.dumps(PLATFORM_DESCRIPTIONS, ensure_ascii=False)};
  const buttons = document.querySelectorAll('.tab-btn');
  const searchBox = document.getElementById('searchBox');
  const newOnly = document.getElementById('newOnly');
  const banner = document.getElementById('platformBanner');
  const cards = document.querySelectorAll('.item-card');
  let activeSource = 'all';

  function applyFilters() {{
    const q = searchBox.value.trim().toLowerCase();
    const onlyNew = newOnly.checked;
    banner.textContent = platformDescs[activeSource] || '';
    cards.forEach(card => {{
      const srcOk = activeSource === 'all' || card.dataset.source === activeSource;
      const newOk = !onlyNew || card.dataset.new === '1';
      const searchOk = !q || card.dataset.search.includes(q);
      card.style.display = (srcOk && newOk && searchOk) ? '' : 'none';
    }});
  }}

  buttons.forEach(btn => {{
    btn.addEventListener('click', () => {{
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeSource = btn.dataset.source;
      applyFilters();
    }});
  }});
  searchBox.addEventListener('input', applyFilters);
  newOnly.addEventListener('change', applyFilters);
</script>
</body>
</html>
"""


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)

    keywords, sources = load_config(SOURCES_PATH)
    run_ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    date_slug = datetime.now().strftime("%Y-%m-%d")

    all_items: list[TrendItem] = []
    statuses: list[SourceStatus] = []

    for src in sources:
        if not src.get("enabled", True):
            statuses.append(
                SourceStatus(
                    source_id=src["id"],
                    source_name=src["name"],
                    ok=False,
                    fetched_count=0,
                    kept_count=0,
                    elapsed_ms=0,
                    error="disabled (StealthyFetcher 필요)",
                )
            )
            continue

        parser = PARSERS.get(src["id"])
        if not parser:
            continue

        t0 = time.perf_counter()
        try:
            fetched = parser(src)
            kept: list[TrendItem] = []
            if src.get("filter_by_keywords", False):
                for item in fetched:
                    haystack = f"{item.title} {item.summary}"
                    matched = match_keywords(haystack, keywords)
                    if matched:
                        item.matched_keywords = matched
                        kept.append(item)
            else:
                kept = fetched

            elapsed = int((time.perf_counter() - t0) * 1000)
            all_items.extend(kept)
            statuses.append(
                SourceStatus(
                    source_id=src["id"],
                    source_name=src["name"],
                    ok=True,
                    fetched_count=len(fetched),
                    kept_count=len(kept),
                    elapsed_ms=elapsed,
                )
            )
        except Exception as exc:
            elapsed = int((time.perf_counter() - t0) * 1000)
            statuses.append(
                SourceStatus(
                    source_id=src["id"],
                    source_name=src["name"],
                    ok=False,
                    fetched_count=0,
                    kept_count=0,
                    elapsed_ms=elapsed,
                    error=f"{type(exc).__name__}: {exc}",
                )
            )

    enrich_arxiv_abstracts(all_items, limit=8)

    prev_date, prev_urls = load_previous_urls(DATA_DIR, date_slug)
    if prev_urls:
        for it in all_items:
            it.is_new = it.url not in prev_urls

    json_path = DATA_DIR / f"{date_slug}.json"
    with json_path.open("w", encoding="utf-8") as f:
        json.dump(
            {
                "generated_at": run_ts,
                "previous_run": prev_date,
                "statuses": [asdict(s) for s in statuses],
                "items": [asdict(i) for i in all_items],
            },
            f,
            ensure_ascii=False,
            indent=2,
        )

    md_path = REPORTS_DIR / f"{date_slug}.md"
    md_content = render_markdown(run_ts, statuses, all_items, prev_date=prev_date)
    md_path.write_text(md_content, encoding="utf-8")

    curated = load_curated_summary(DATA_DIR, date_slug)
    ko_notes = load_ko_notes(DATA_DIR, date_slug)
    html_path = REPORTS_DIR / f"{date_slug}.html"
    html_content = render_html(
        run_ts, statuses, all_items, prev_date=prev_date, curated=curated, ko_notes=ko_notes
    )
    html_path.write_text(html_content, encoding="utf-8")

    print(f"Saved JSON: {json_path}")
    print(f"Saved Markdown: {md_path}")
    print(f"Saved HTML: {html_path}")
    for st in statuses:
        print(
            f"  - {st.source_id}: ok={st.ok}, fetched={st.fetched_count}, kept={st.kept_count}, {st.elapsed_ms}ms {st.error}"
        )


if __name__ == "__main__":
    main()
