#!/usr/bin/env python3
"""Write dist/index.html: the same page without the <!doctype>/<html>/<head>/<body> wrapper,
for hosts (such as claude.ai Artifacts) that add their own document skeleton.
The css/, js/ and data/ folders are published alongside it unchanged."""
import os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(ROOT, 'index.html')).read()
body = re.sub(r'<!doctype html>\s*|</?html[^>]*>\s*|</?head>\s*|</?body>\s*', '', src, flags=re.I)
body = re.sub(r'<meta charset[^>]*>\s*|<meta name="viewport"[^>]*>\s*', '', body)
# Vercel's analytics scripts only exist on Vercel; drop them from this copy.
body = re.sub(r'<script>\s*// Vercel Web Analytics.*?</script>\s*', '', body, flags=re.S)
# The title must come first so hosts that scan the top of the file find it.
title = re.search(r'<title>.*?</title>', body).group(0)
body = title + '\n' + body.replace(title, '', 1).lstrip()
os.makedirs(os.path.join(ROOT, 'dist'), exist_ok=True)
open(os.path.join(ROOT, 'dist', 'index.html'), 'w').write(body)
print(body)
