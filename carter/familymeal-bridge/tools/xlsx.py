"""Minimal stdlib .xlsx reader (shared strings + first or named sheet). No deps."""
import re, zipfile
import xml.etree.ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}


def _col(ref):
    n = 0
    for ch in re.match(r"[A-Z]+", ref).group():
        n = n * 26 + ord(ch) - 64
    return n - 1


def sheets(path):
    with zipfile.ZipFile(path) as z:
        wb = ET.fromstring(z.read("xl/workbook.xml"))
        rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        target = {r.get("Id"): r.get("Target") for r in rels}
        return {s.get("name"): "xl/" + target[s.get(f"{{{NS['r']}}}id")].lstrip("/").removeprefix("xl/")
                for s in wb.find("m:sheets", NS)}


def rows(path, sheet=None):
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
                shared.append("".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t")))
        sh = sheets(path)
        name = sheet or next(iter(sh))
        root = ET.fromstring(z.read(sh[name]))
        for row in root.iter(f"{{{NS['m']}}}row"):
            out = {}
            for c in row.findall("m:c", NS):
                v = c.find("m:v", NS)
                t = c.get("t")
                if t == "inlineStr":
                    val = "".join(x.text or "" for x in c.iter(f"{{{NS['m']}}}t"))
                elif v is None:
                    continue
                elif t == "s":
                    val = shared[int(v.text)]
                else:
                    val = v.text
                out[_col(c.get("r"))] = val
            if out:
                yield [out.get(i, "") for i in range(max(out) + 1)]
