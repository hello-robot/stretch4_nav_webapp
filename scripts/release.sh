#!/usr/bin/env bash
# Build the PyPI artifacts: the UI first, then the Python package.


set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Building the UI"
(cd frontend && npm ci && npm run build)

static="stretch4_nav_webapp/static"
[ -f "$static/index.html" ] || { echo "ERROR: $static/index.html missing after npm run build" >&2; exit 1; }
[ -d "$static/assets" ] || { echo "ERROR: $static/assets missing after npm run build" >&2; exit 1; }

echo "==> Building the wheel and the sdist"
rm -rf dist build ./*.egg-info
python3 -m build

echo "==> Checking the artifacts carry the UI and the config"
python3 - <<'PY'
import glob, sys, tarfile, zipfile

(whl,) = glob.glob("dist/*.whl")
(sdist,) = glob.glob("dist/*.tar.gz")

def check(label, names, prefix=""):
    need = [f"{prefix}stretch4_nav_webapp/{p}"
            for p in ("static/index.html", "config/default.yaml")]
    missing = [n for n in need if n not in names]
    assets = [n for n in names
              if n.startswith(f"{prefix}stretch4_nav_webapp/static/assets/")]
    if missing or not assets:
        sys.exit(f"ERROR: {label} is missing {missing or 'static/assets/*'}")
    print(f"    OK {label}  ({len(assets)} UI asset(s) + config)")

check(whl, zipfile.ZipFile(whl).namelist())
with tarfile.open(sdist) as tf:
    names = tf.getnames()
check(sdist, names, prefix=f"{names[0].split('/')[0]}/")
PY

# twine needs packaging >= 24.2 to read the Metadata 2.4 that the license
# fields produce; older versions fail at upload too, with a confusing error.
python3 - <<'VERCHECK'
import sys
import packaging
from packaging.version import Version

if Version(packaging.__version__) < Version("24.2"):
    sys.exit(
        f"ERROR: packaging {packaging.__version__} is too old to validate this "
        "package (needs >= 24.2).\n"
        "       Fix with: pip3 install --user -U build twine"
    )
VERCHECK

python3 -m twine check dist/*

cat <<'MSG'

==> Ready. Upload with:
      python3 -m twine upload dist/*

    Test it first if you like:
      python3 -m twine upload --repository testpypi dist/*
MSG
