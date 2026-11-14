"""Document layout: JSON context on stdin; complete HTML on stdout. Python stdlib only."""
import html
import json
import sys

context = json.load(sys.stdin)
title = html.escape(context["title"])
base = html.escape(context["baseUrl"], quote=True)
sections = "\n".join(
    '<section data-section-id="' + html.escape(section["id"], quote=True) + '">'
    + section["html"] + '</section>' for section in context["sections"]
)
sys.stdout.write(
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    f'<base href="{base}"><title>{title}</title><style>{context["css"]}</style>'
    f'</head><body><main class="document">{sections}</main></body></html>'
)
