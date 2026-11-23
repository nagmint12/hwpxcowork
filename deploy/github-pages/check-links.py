"""Validate links against the exact GitHub Pages artifact before publishing."""
import argparse
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.targets = set()
        self.links = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get("id"):
            self.targets.add(attrs["id"])
        if tag == "a" and attrs.get("name"):
            self.targets.add(attrs["name"])
        for key in ("href", "src", "poster", "action", "data-pages-editor"):
            if attrs.get(key):
                self.links.append(attrs[key])
        if attrs.get("name") == "hwpx-personal-app":
            self.links.append(attrs["content"])


def audit(root, base):
    site = "https://pages.invalid" + base
    pages = {}
    references = []
    for file in sorted(root.rglob("*.html")):
        name = file.relative_to(root).as_posix()
        page = Page()
        page.feed(file.read_text(encoding="utf-8"))
        pages[name] = page
        references.extend((name, href) for href in page.links)
    if "index.html" not in pages:
        raise SystemExit("Missing Pages entry point")

    for file in sorted(root.rglob("*.css")):
        name = file.relative_to(root).as_posix()
        css = re.sub(r"/\*.*?\*/", "", file.read_text(encoding="utf-8"), flags=re.S)
        for match in re.finditer(r"""url\(\s*(['"]?)(.*?)\1\s*\)""", css, re.I):
            references.append((name, match[2]))

    # The help page loads this Markdown at runtime. Inspect its link destinations, too.
    manual = root / "manual.md"
    if manual.is_file():
        for href in re.findall(r"\]\(([^)\s]+)\)", manual.read_text(encoding="utf-8")):
            references.append(("manual.md", href))

    # The document shell renders Vue links and help targets from JavaScript templates.
    for file in root.glob("*.js"):
        if file.name == "personal-worker.js":
            continue
        js = file.read_text(encoding="utf-8")
        for href in re.findall(r"""(?<!:)\bhref=["']([^"'<>{}\s]+)["']""", js):
            if not href.startswith(("/", "https://", "#/")):
                continue
            references.append(("index.html", href))
        for href in set(re.findall(r"""["'`](/[^"'`\s]*help\.html#[\w-]+)["'`]""", js)):
            references.append(("index.html", href))
    for file in (root / "manual-resources").glob("*.md"):
        for href in re.findall(r"\]\(([^)\s]+)\)", file.read_text(encoding="utf-8")):
            references.append((file.relative_to(root).as_posix(), href))

    external = set()
    errors = set()
    local = 0
    for name, href in references:
        url = urlsplit(urljoin(site + name, href))
        if url.scheme not in ("http", "https"):
            continue
        if url.netloc != "pages.invalid":
            external.add(url.geturl())
            continue
        local += 1
        path = unquote(url.path)
        if not path.startswith(base):
            errors.add(f"{name} -> {href} (outside {base})")
            continue
        target = path[len(base):]
        if (root / target).is_dir():
            target = target.rstrip("/") + "/index.html" if target else "index.html"
        if not (root / target).is_file():
            errors.add(f"{name} -> {href} (missing file)")
        elif target in pages and url.fragment and not (target == "index.html" and url.fragment.startswith("/")):
            if unquote(url.fragment) not in pages[target].targets:
                errors.add(f"{name} -> {href} (missing anchor)")
    print(f"{len(pages)} HTML pages, {local} local references, {len(external)} distinct external URLs, {len(errors)} errors")
    if errors:
        raise SystemExit("\n".join(sorted(errors)))
    return external


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("out", type=Path)
    parser.add_argument("--base", required=True, help="Pages project path with leading and trailing slashes")
    args = parser.parse_args()
    audit(args.out.resolve(), args.base)
