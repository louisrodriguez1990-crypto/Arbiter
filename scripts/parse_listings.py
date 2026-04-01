#!/usr/bin/env python3
"""
Extract titles, prices, and links from saved marketplace HTML (or a URL fetch).

JS-heavy sites (Marketplace, OfferUp, etc.):
  • Use --render to run a headless Chromium (Playwright) so you get post-JS HTML, then parse.
  • Use --a11y with --render to also read the accessibility tree (flattened to text). Often surfaces
    price/title when the DOM is minified or redundant — complementary to HTML parsing, not a guarantee.
  • Use --save-html to persist the HTML snapshot for later or debugging.

One-time setup:
  pip install -r requirements.txt
  playwright install chromium

Usage:
  python scripts/parse_listings.py listing.html
  python scripts/parse_listings.py -u "https://..." --render --wait-ms 3000
  python scripts/parse_listings.py -u "https://..." --render --save-html listing.html
  python scripts/parse_listings.py -u "https://..." --render --save-html listing.html --snapshot-only
  Get-Content dump.html | python scripts/parse_listings.py -
  python scripts/parse_listings.py ./snapshots/ --batch
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None

from bs4 import BeautifulSoup

# Marketplace-ish paths (heuristic for search-result pages)
LISTING_HINT = re.compile(
    r"(/marketplace/item/|/item/detail/|/d/|/listing/|/p/|/b/|/cto/|/search\?)",
    re.I,
)
PRICE_RE = re.compile(r"\$\s*([\d,]+(?:\.\d{2})?)")


def _read_stdin() -> str:
    return sys.stdin.read()


def _fetch_url(url: str, timeout: float) -> str:
    if requests is None:
        raise SystemExit("Install requests: pip install requests")
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; ArbiterListingParser/1.0; +local research)",
        "Accept": "text/html,application/xhtml+xml",
    }
    r = requests.get(url, timeout=timeout, headers=headers)
    r.raise_for_status()
    return r.text


def _flatten_a11y_names(node: Any, lines: list[str] | None = None) -> list[str]:
    """Collect non-empty accessible names in document order (compressed semantic view of the page)."""
    if lines is None:
        lines = []
    if isinstance(node, dict):
        n = node.get("name")
        if isinstance(n, str):
            s = n.strip()
            if s:
                lines.append(s)
        for ch in node.get("children") or []:
            _flatten_a11y_names(ch, lines)
    elif isinstance(node, list):
        for x in node:
            _flatten_a11y_names(x, lines)
    return lines


def fetch_rendered_html(
    url: str,
    *,
    timeout_ms: float,
    wait_ms: int,
    wait_until: str,
    collect_a11y: bool = False,
) -> tuple[str, dict[str, Any] | None]:
    """Load URL in headless Chromium; wait for JS. Optionally capture flattened accessibility tree.

    Returns (html, a11y_pack_or_none). a11y_pack has: text, lines (capped), line_count, prices_guess.
    Requires: pip install playwright && playwright install chromium
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise SystemExit(
            "Playwright not installed. Run: pip install playwright && playwright install chromium"
        ) from None

    a11y_pack: dict[str, Any] | None = None
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            context = browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                ),
                viewport={"width": 1365, "height": 900},
                locale="en-US",
            )
            page = context.new_page()
            page.goto(url, timeout=int(timeout_ms), wait_until=wait_until)  # type: ignore[arg-type]
            if wait_ms > 0:
                page.wait_for_timeout(wait_ms)
            if collect_a11y:
                snap = page.accessibility.snapshot()
                lines = _flatten_a11y_names(snap) if snap else []
                text = "\n".join(lines)
                a11y_pack = {
                    "text": text,
                    "lines": lines[:400],
                    "line_count": len(lines),
                    "prices_guess": _extract_prices(text, max_n=32),
                }
            html = page.content()
        finally:
            browser.close()
    return html, a11y_pack


def _parse_json_ld_scripts(soup: BeautifulSoup) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for tag in soup.find_all("script", type=lambda x: x and "ld+json" in x):
        raw = tag.string or tag.get_text() or ""
        raw = raw.strip()
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(data, list):
            for item in data:
                if isinstance(item, dict):
                    out.append(item)
        elif isinstance(data, dict):
            out.append(data)
    return out


def _walk_offers(obj: Any, acc: list[dict[str, Any]]) -> None:
    if isinstance(obj, dict):
        t = obj.get("@type")
        types = t if isinstance(t, list) else [t] if t else []
        if any(str(x).lower() in ("product", "offer", "listing", "listitem") for x in types):
            acc.append(obj)
        for v in obj.values():
            _walk_offers(v, acc)
    elif isinstance(obj, list):
        for x in obj:
            _walk_offers(x, acc)


def _og_meta(soup: BeautifulSoup) -> dict[str, str]:
    meta: dict[str, str] = {}
    for prop in ("og:title", "og:description", "og:url", "og:image"):
        tag = soup.find("meta", property=prop)
        if tag and tag.get("content"):
            meta[prop] = tag["content"].strip()
    for name in ("description", "title"):
        tag = soup.find("meta", attrs={"name": name})
        if tag and tag.get("content"):
            meta[f"meta:{name}"] = tag["content"].strip()
    return meta


def _visible_text_sample(soup: BeautifulSoup, limit: int = 8000) -> str:
    for bad in soup(["script", "style", "noscript"]):
        bad.decompose()
    text = soup.get_text(separator=" ", strip=True)
    return " ".join(text.split())[:limit]


def _extract_prices(text: str, max_n: int = 24) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for m in PRICE_RE.finditer(text):
        s = m.group(0).replace(" ", "")
        if s not in seen:
            seen.add(s)
            out.append(s)
        if len(out) >= max_n:
            break
    return out


def _harvest_links(soup: BeautifulSoup, base: str | None) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href or href.startswith("#"):
            continue
        full = urljoin(base or "", href) if base else href
        if LISTING_HINT.search(full) or any(
            h in full.lower() for h in ("marketplace", "offerup", "craigslist", "mercari", "/item")
        ):
            title = " ".join(a.get_text(separator=" ", strip=True).split())[:200]
            rows.append({"href": full, "anchor": title})
    # dedupe by href
    by_href: dict[str, dict[str, str]] = {}
    for r in rows:
        by_href[r["href"]] = r
    return list(by_href.values())[:80]


def _merge_price_lists(*lists: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for lst in lists:
        for s in lst:
            if s not in seen:
                seen.add(s)
                out.append(s)
    return out


def parse_listing_html(
    html: str,
    *,
    source: str = "",
    page_url: str | None = None,
    a11y_pack: dict[str, Any] | None = None,
) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    json_ld = _parse_json_ld_scripts(soup)
    structured: list[dict[str, Any]] = []
    for blob in json_ld:
        _walk_offers(blob, structured)

    og = _og_meta(soup)
    title_tag = soup.title.string.strip() if soup.title and soup.title.string else ""
    text = _visible_text_sample(soup)
    dom_prices = _extract_prices(text)
    a11y_prices: list[str] = []
    a11y_text = ""
    if a11y_pack:
        a11y_text = str(a11y_pack.get("text") or "")
        a11y_prices = list(a11y_pack.get("prices_guess") or _extract_prices(a11y_text))
    prices = _merge_price_lists(dom_prices, a11y_prices)

    base = page_url or og.get("og:url") or ""
    links = _harvest_links(soup, base if base else None)

    warnings: list[str] = []
    if len(text) < 200 and len(a11y_text) < 200:
        warnings.append(
            "Very little visible text and thin a11y tree — try --render --a11y, or save HTML from the browser "
            "after the listing loads; some sites block bots or require login."
        )
    elif len(text) < 200 and len(a11y_text) >= 200:
        warnings.append(
            "DOM text was thin but accessibility names had more signal — check a11y_text_sample and prices_from_a11y."
        )

    out: dict[str, Any] = {
        "source": source,
        "title": og.get("og:title") or title_tag or None,
        "description": og.get("og:description") or og.get("meta:description"),
        "page_url": og.get("og:url") or page_url,
        "prices_guess": prices,
        "json_ld_blocks": len(json_ld),
        "structured_snippets": structured[:12],
        "og": og,
        "candidate_links": links[:40],
        "text_sample": text[:1200],
        "warnings": warnings,
    }
    if a11y_pack:
        out["prices_from_dom"] = dom_prices
        out["prices_from_a11y"] = a11y_prices
        out["a11y_line_count"] = a11y_pack.get("line_count")
        out["a11y_text_sample"] = a11y_text[:2000]
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Parse saved marketplace listing HTML into JSON.")
    ap.add_argument(
        "path",
        nargs="?",
        help="HTML file path, or '-' for stdin",
    )
    ap.add_argument("-u", "--url", help="Fetch URL (plain HTTP unless --render)")
    ap.add_argument(
        "--render",
        action="store_true",
        help="Load URL with headless Chromium (Playwright) so JS executes before parse",
    )
    ap.add_argument(
        "--save-html",
        metavar="FILE",
        help="Write raw HTML snapshot to FILE (after fetch/render), then parse unless --snapshot-only",
    )
    ap.add_argument(
        "--snapshot-only",
        action="store_true",
        help="With -u and --save-html: only save HTML, do not print JSON",
    )
    ap.add_argument("--timeout", type=float, default=45.0, help="Seconds (HTTP) or page navigation budget (--render)")
    ap.add_argument(
        "--wait-ms",
        type=int,
        default=None,
        metavar="N",
        help="Extra ms after load (default 2500 with --render, 0 otherwise; set 0 to skip extra wait)",
    )
    ap.add_argument(
        "--wait-until",
        choices=("commit", "domcontentloaded", "load", "networkidle"),
        default="domcontentloaded",
        help="Playwright navigation wait (default domcontentloaded; networkidle can hang on SPAs)",
    )
    ap.add_argument(
        "--a11y",
        action="store_true",
        help="With --render: flatten accessibility tree to text (often surfaces price/title vs noisy DOM)",
    )
    ap.add_argument("--batch", action="store_true", help="Treat path as a directory of .html files")
    args = ap.parse_args()

    if args.snapshot_only and not (args.url and args.save_html):
        ap.error("--snapshot-only requires -u and --save-html")

    if args.render and not args.url:
        ap.error("--render requires -u URL")

    if args.a11y and not args.render:
        ap.error("--a11y requires --render")

    if args.url and args.path is not None and args.path != "-":
        ap.error("Use either -u URL or an HTML file path, not both")

    if args.wait_ms is None:
        wait_ms = 2500 if args.render else 0
    else:
        wait_ms = max(0, args.wait_ms)

    def acquire_html_from_url() -> tuple[str, dict[str, Any] | None]:
        if args.render:
            return fetch_rendered_html(
                args.url,
                timeout_ms=args.timeout * 1000.0,
                wait_ms=wait_ms,
                wait_until=args.wait_until,
                collect_a11y=args.a11y,
            )
        return _fetch_url(args.url, args.timeout), None

    if args.url:
        html, a11y_pack = acquire_html_from_url()
        snap_path: str | None = None
        if args.save_html:
            out = Path(args.save_html)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(html, encoding="utf-8")
            snap_path = str(out.resolve())
        if args.snapshot_only:
            print(snap_path or args.save_html)
            return
        result = parse_listing_html(html, source=args.url, page_url=args.url, a11y_pack=a11y_pack)
        if snap_path:
            result["snapshot_path"] = snap_path
        if args.render:
            result["fetch_mode"] = "playwright+a11y" if args.a11y else "playwright"
        else:
            result["fetch_mode"] = "requests"
        print(json.dumps(result, indent=2))
        return

    if args.batch:
        if not args.path:
            ap.error("batch mode requires a directory path")
        root = Path(args.path)
        if not root.is_dir():
            raise SystemExit(f"Not a directory: {root}")
        all_out: list[dict[str, Any]] = []
        for p in sorted(root.glob("*.html")) + sorted(root.glob("*.htm")):
            html = p.read_text(encoding="utf-8", errors="replace")
            one = parse_listing_html(html, source=str(p))
            one["file"] = str(p)
            all_out.append(one)
        print(json.dumps(all_out, indent=2))
        return

    if args.path in (None, "-"):
        html = _read_stdin()
        src = "stdin"
    else:
        p = Path(args.path)
        html = p.read_text(encoding="utf-8", errors="replace")
        src = str(p)

    result = parse_listing_html(html, source=src)
    if args.save_html:
        snap = Path(args.save_html)
        snap.parent.mkdir(parents=True, exist_ok=True)
        snap.write_text(html, encoding="utf-8")
        result["snapshot_path"] = str(snap.resolve())
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
