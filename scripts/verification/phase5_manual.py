"""Read installed Qt help files without changing the installation."""
import argparse
import pathlib
import sqlite3
import zlib
import sys
import re
import html
sys.stdout.reconfigure(encoding="utf-8")

parser = argparse.ArgumentParser()
parser.add_argument("query", nargs="?", default="script")
parser.add_argument("--extract", action="store_true")
args = parser.parse_args()
path = pathlib.Path(r"D:\OneDrive\Documenti\Plexim\PLECS 4.9 (64 bit)\onlinehelp\plecshelp.qch")
db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
rows = db.execute("SELECT Name, FileId FROM FileNameTable WHERE lower(Name) LIKE ?", ("%" + args.query.lower() + "%",)).fetchall()
for name, identifier in rows:
    print(name, identifier)
    if args.extract:
        data = db.execute("SELECT Data FROM FileDataTable WHERE Id=?", (identifier,)).fetchone()[0]
        content = zlib.decompress(data[4:]).decode("utf-8", errors="replace")
        print(html.unescape(re.sub("<[^>]+>", " ", content)))
