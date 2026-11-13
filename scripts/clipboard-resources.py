"""Validate copied HWPX packages and repair unavailable image resources in copies.

Never reads a referenced filesystem path or URL. Original packages are untouched.
"""
import io
import posixpath
import re
import struct
import zlib
import zipfile
import xml.etree.ElementTree as ET

MAX_EXPANDED_BYTES = 256 * 1024 * 1024
MAX_ENTRY_BYTES = 128 * 1024 * 1024
MAX_ENTRIES = 4096
HP = '{http://www.hancom.co.kr/hwpml/2011/paragraph}'
HC = '{http://www.hancom.co.kr/hwpml/2011/core}'


def validate_archive(archive):
    entries = archive.infolist()
    if len(entries) > MAX_ENTRIES or sum(e.file_size for e in entries) > MAX_EXPANDED_BYTES or any(e.file_size > MAX_ENTRY_BYTES for e in entries):
        raise ValueError('FRAGMENT_TOO_LARGE')
    if archive.read('mimetype') != b'application/hwp+zip':
        raise ValueError('INVALID_FRAGMENT')


def placeholder_png():
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    rows = bytearray()
    for y in range(32):
        rows.append(0)
        for x in range(32):
            red = abs(x-y) <= 1 or abs(x+y-31) <= 1
            rows.extend((190, 35, 35) if red else (238, 238, 238))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 32, 32, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(bytes(rows))) + chunk(b'IEND', b'')


def image_problem(data):
    if not data:
        return 'EMPTY_DATA'
    # Metafiles/SVG are vector resources. Do not require a rasterizer to retain them.
    if data[:4] == b'\xd7\xcd\xc6\x9a' or data[40:44] == b' EMF' or b'<svg' in data[:2048]:
        return None
    try:
        from PIL import Image
    except ImportError:
        return None if data.startswith((b'BM', b'\x89PNG\r\n\x1a\n', b'\xff\xd8', b'GIF8', b'II*\0', b'MM\0*')) else 'INVALID_DATA'
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.load()
        return None
    except Exception:
        return 'INVALID_DATA'


def repair_images(data):
    """Return (copy, warnings); retain geometry and use an explicit missing icon."""
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        validate_archive(archive)
        names = set(archive.namelist())
        if 'Contents/content.hpf' not in names:
            return data, []
        manifest_bytes = archive.read('Contents/content.hpf')
        manifest = ET.fromstring(manifest_bytes)
        items = {n.get('id'): n for n in manifest.iter() if n.tag.rsplit('}', 1)[-1] == 'item'}
        problems = {}
        def problem(ref):
            if ref in problems:
                return problems[ref]
            node = items.get(ref)
            href = node.get('href', '') if node is not None else ''
            found = None
            # ZIP members only; never fall back to open(href), network or working dir.
            for candidate in [href, posixpath.normpath(href), posixpath.normpath('Contents/' + href)]:
                if candidate in names and candidate.startswith('BinData/') and not candidate.endswith('/'):
                    found = candidate
                    break
            reason = 'EMPTY_REFERENCE' if not ref else 'MISSING_ITEM' if node is None else 'MISSING_FILE' if found is None else image_problem(archive.read(found))
            problems[ref] = reason
            return reason
        changes, warnings = {}, []
        suffix = 1
        while 'HwpxCoworkMissingImage' + str(suffix) in items or 'BinData/hwpx-cowork-missing-image-' + str(suffix) + '.png' in names:
            suffix += 1
        missing_id = 'HwpxCoworkMissingImage' + str(suffix)
        missing_path = 'BinData/hwpx-cowork-missing-image-' + str(suffix) + '.png'
        for name in sorted(names):
            if name != 'Contents/header.xml' and not (name.startswith(('Contents/section', 'Contents/masterpage')) and name.endswith('.xml')):
                continue
            xml = archive.read(name)
            root = ET.fromstring(xml)
            changed = False
            for image in root.iter(HC + 'img'):
                ref = image.get('binaryItemIDRef', '')
                reason = problem(ref)
                if reason:
                    image.set('binaryItemIDRef', missing_id)
                    warnings.append({'code': 'MISSING_IMAGE', 'part': name, 'reference': ref, 'reason': reason})
                    changed = True
            if changed:
                for _, (prefix, uri) in ET.iterparse(io.BytesIO(xml), events=['start-ns']):
                    if not re.fullmatch(r'ns\d+', prefix):
                        ET.register_namespace(prefix, uri)
                changes[name] = ET.tostring(root, encoding='utf-8', xml_declaration=True)
        # Neutralize unavailable manifest image entries too. Hancom must not
        # resolve a leftover file/UNC/URL path while opening the copied package.
        for ref, item in items.items():
            if item.get('media-type', '').startswith('image/'):
                reason = problem(ref)
                if reason:
                    if not any(w['reference'] == ref for w in warnings):
                        warnings.append({'code': 'MISSING_IMAGE', 'part': 'Contents/content.hpf', 'reference': ref, 'reason': reason})
                    item.set('href', missing_path)
                    item.set('media-type', 'image/png')
                    item.set('isEmbeded', '1')
        if not warnings:
            return data, []
        item_parent = next((n for n in manifest.iter() if any(c.tag.rsplit('}', 1)[-1] == 'item' for c in n)), None)
        if item_parent is None:
            raise ValueError('INVALID_FRAGMENT')
        item_tag = next(iter(items.values())).tag
        ET.SubElement(item_parent, item_tag, {'id': missing_id, 'href': missing_path, 'media-type': 'image/png', 'isEmbeded': '1'})
        for _, (prefix, uri) in ET.iterparse(io.BytesIO(manifest_bytes), events=['start-ns']):
            if not re.fullmatch(r'ns\d+', prefix):
                ET.register_namespace(prefix, uri)
        changes['Contents/content.hpf'] = ET.tostring(manifest, encoding='utf-8', xml_declaration=True)
        changes[missing_path] = placeholder_png()
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as target:
            for entry in archive.infolist():
                target.writestr(entry, changes.pop(entry.filename, archive.read(entry)))
            for name, content in changes.items():
                target.writestr(name, content)
        return output.getvalue(), warnings
