"""Generate controlled HWPX inputs from the small-table benchmark."""
import argparse
from copy import deepcopy
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from lxml import etree as ET


def make_fixture(template, directory, pages):
    name = directory / f"scale-{pages}.hwpx"
    with ZipFile(template) as source, ZipFile(name, "x") as dest:
        section = ET.fromstring(source.read("Contents/section0.xml"))
        first, body, table = list(section)[0], list(section)[7], list(section)[8]
        for child in list(section):
            section.remove(child)
        next_id = 1
        middle = 2 if pages == 3 else pages // 2
        for page in range(1, pages + 1):
            marker = f"P{page:04}"
            lines = [f"{marker} 검토 기록", "자료 수정 전 원문을 확인합니다.",
                     "검토 기준과 적용 범위를 기록합니다.", "이번 회의의 결정 사항입니다.",
                     "담당자가 다음 회의에서 확인합니다.", f"{marker} 끝"]
            for line, label in enumerate(lines):
                is_table = line == 3 and page in (3, middle)
                item = deepcopy(table if is_table else first if page == 1 and line == 0 else body)
                if is_table:
                    item.find(".//{*}tbl").set("id", str(154000000 + page))
                else:
                    item.find(".//{*}t").text = label
                item.set("pageBreak", str(int(page > 1 and line == 0)))
                for para in [item, *item.findall(".//{*}p")]:
                    para.set("id", str(next_id))
                    next_id += 1
                section.append(item)
        for entry in source.infolist():
            data = ET.tostring(section, encoding="UTF-8", xml_declaration=True, standalone=True) if entry.filename == "Contents/section0.xml" else source.read(entry)
            dest.writestr(entry, data)
    return name


def chunk_fixture(single, target, pages):
    """Keep the same paragraphs and put section starts on pages 46, 96, 146, … ."""
    def xml(element):
        return ET.tostring(element, encoding="UTF-8", xml_declaration=True, standalone=True)

    with ZipFile(single) as source, ZipFile(target, "x") as dest:
        root = ET.fromstring(source.read("Contents/section0.xml"))
        section_run = deepcopy(root[0][0])
        starts = [1, *range(46, pages + 1, 50), pages + 1]
        items = list(root)
        for item in items:
            root.remove(item)
        content = ET.fromstring(source.read("Contents/content.hpf"))
        header = ET.fromstring(source.read("Contents/header.xml"))
        rdf = ET.fromstring(source.read("META-INF/container.rdf"))
        rdf0 = [elem for elem in rdf if b"Contents/section0.xml" in ET.tostring(elem)]
        manifest0 = content.find(".//{*}item[@id='section0']")
        spine0 = content.find(".//{*}itemref[@idref='section0']")
        changes = {}
        for idx, (start, end) in enumerate(zip(starts, starts[1:])):
            current = deepcopy(root)
            block = items[(start - 1) * 6:(end - 1) * 6]
            if idx:
                block[0].set("pageBreak", "0")
                block[0].insert(0, deepcopy(section_run))
                section_id = f"section{idx}"
                item = deepcopy(manifest0)
                item.set("id", section_id)
                item.set("href", f"Contents/{section_id}.xml")
                manifest0.getparent().append(item)
                ref = deepcopy(spine0)
                ref.set("idref", section_id)
                spine0.getparent().append(ref)
                for elem in rdf0:
                    rdf.append(ET.fromstring(ET.tostring(elem).replace(b"section0.xml", f"{section_id}.xml".encode())))
            current.extend(block)
            changes[f"Contents/section{idx}.xml"] = xml(current)
        header.set("secCnt", str(len(starts) - 1))
        changes.update({"Contents/header.xml": xml(header), "Contents/content.hpf": xml(content),
                        "META-INF/container.rdf": xml(rdf)})
        for entry in source.infolist():
            data = changes.pop(entry.filename) if entry.filename in changes else source.read(entry)
            dest.writestr(entry, data)
        for name, data in changes.items():
            dest.writestr(ZipInfo(name, (2026, 11, 21, 0, 0, 0)), data, compress_type=ZIP_DEFLATED)
    return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("pages", type=int, nargs="*", default=[10, 1000, 2000])
    parser.add_argument("--split-from", type=Path, help="keep content from these single-section inputs")
    args = parser.parse_args()
    args.directory.mkdir(parents=True, exist_ok=True)
    template = next(Path(__file__).resolve().parents[1].glob("01_*.hwpx"))
    for size in args.pages:
        if args.split_from:
            name = f"scale-{size}.hwpx"
            print(chunk_fixture(args.split_from / name, args.directory / name, size))
        else:
            print(make_fixture(template, args.directory, size))
