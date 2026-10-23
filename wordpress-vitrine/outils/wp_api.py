# -*- coding: utf-8 -*-
"""Utilitaire API REST WordPress pour www.lumenjuris.com.

Lit les identifiants dans config.txt (racine du depot) :
  ligne 1 : URL du site
  ligne 3 : mot de passe d'application (utilisateur "admin").

Usage :
  python wp_api.py list
  python wp_api.py get <id>            -> JSON complet (context=edit) sur stdout
  python wp_api.py backup <dossier>    -> sauvegarde JSON + HTML rendu de toutes les pages
  python wp_api.py update <id> <fichier_contenu_html>  -> met a jour le contenu de la page
"""
import base64
import io
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

def creds():
    # En ligne (routine cloud) : variables WP_SITE, WP_USER et WP_APP_PASSWORD.
    # Sur le PC : config.txt a la racine du depot.
    user = os.environ.get("WP_USER", "admin")
    app_password = os.environ.get("WP_APP_PASSWORD")
    if app_password:
        site = os.environ.get("WP_SITE", "https://www.lumenjuris.com").rstrip("/")
    else:
        lines = (ROOT / "config.txt").read_text(encoding="utf-8").splitlines()
        site = lines[0].strip().rstrip("/")
        app_password = lines[2].strip()
    token = base64.b64encode(f"{user}:{app_password}".encode()).decode()
    return site, token

SITE, TOKEN = creds()
UA = "Mozilla/5.0 (LumenJuris maintenance script)"

def req(url, data=None, auth=True, method=None):
    headers = {"User-Agent": UA}
    if auth:
        headers["Authorization"] = f"Basic {TOKEN}"
    if data is not None:
        data = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(r, timeout=60) as resp:
        return resp.read().decode("utf-8")

def list_pages():
    out = req(f"{SITE}/wp-json/wp/v2/pages?per_page=100&context=edit&_fields=id,slug,link,modified,status")
    return json.loads(out)

def get_page(pid):
    return json.loads(req(f"{SITE}/wp-json/wp/v2/pages/{pid}?context=edit"))

def backup(folder):
    folder = Path(folder)
    (folder / "html").mkdir(parents=True, exist_ok=True)
    pages = list_pages()
    for p in pages:
        full = get_page(p["id"])
        name = f"{p['slug']}--id{p['id']}"
        (folder / f"{name}.json").write_text(
            json.dumps(full, ensure_ascii=False, indent=2), encoding="utf-8")
        try:
            html = req(p["link"], auth=False)
            (folder / "html" / f"{name}.html").write_text(html, encoding="utf-8")
        except Exception as e:
            print(f"  ! HTML {p['slug']}: {e}")
        print(f"OK {name}")
    # page d'accueil rendue
    try:
        html = req(f"{SITE}/", auth=False)
        (folder / "html" / "accueil--front.html").write_text(html, encoding="utf-8")
        m = re.search(r"page-id-(\d+)", html)
        print(f"OK accueil (front page = page-id-{m.group(1) if m else '?'})")
    except Exception as e:
        print(f"  ! accueil: {e}")

def update_page(pid, content_file):
    content = Path(content_file).read_text(encoding="utf-8")
    out = req(f"{SITE}/wp-json/wp/v2/pages/{pid}", data={"content": content}, method="POST")
    j = json.loads(out)
    print(f"MAJ page {pid} ({j.get('slug')}), modifie: {j.get('modified')}")

if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "list":
        for p in list_pages():
            print(f"{p['id']:>5}  {p['status']:<8} {p['slug']}")
    elif cmd == "get":
        print(json.dumps(get_page(sys.argv[2]), ensure_ascii=False, indent=2))
    elif cmd == "backup":
        backup(sys.argv[2])
    elif cmd == "update":
        update_page(sys.argv[2], sys.argv[3])
