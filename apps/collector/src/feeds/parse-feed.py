"""Parse bounded public RSS/Atom without resolving entities or executing HTML."""
import json
import sys
import xml.etree.ElementTree as ET

def parse_feed(xml):
    if len(xml) > 2 * 1024 * 1024 or "<!doctype" in xml.lower() or "<!entity" in xml.lower():
        raise ValueError("Feed exceeds limit or contains unsupported declarations")
    root = ET.fromstring(xml)
    local = lambda tag: tag.split("}")[-1]
    if local(root.tag) not in ("rss", "feed", "RDF"):
        raise ValueError("Response is not RSS or Atom")
    rows = []
    for item in root.iter():
        if local(item.tag) not in ("item", "entry"):
            continue
        fields = {}
        for child in item:
            key = local(child.tag)
            if key == "link" and child.get("href") and child.get("rel", "alternate") == "alternate":
                fields["link"] = child.get("href")
            elif key not in fields:
                fields[key] = "".join(child.itertext())
        rows.append({"guid": fields.get("guid") or fields.get("id"), "title": fields.get("title", ""),
                     "link": fields.get("link", ""), "published": fields.get("pubDate") or fields.get("published") or fields.get("updated"),
                     "html": fields.get("encoded") or fields.get("content") or fields.get("description") or fields.get("summary", "")})
        if len(rows) >= 60:
            break
    return rows

if __name__ == "__main__":
    try:
        data = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
        print(json.dumps(parse_feed(data.decode("utf-8-sig")), ensure_ascii=False))
    except (ValueError, ET.ParseError, UnicodeError) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
