#!/usr/bin/env bash
# Build the PyPI artifacts: the UI first, then the Python package.


set -euo pipefail

cd "$(dirname "$0")/.."

# Use a local Node toolchain if one has been unpacked into .node/
# Using the latest nodejs (v24) is important for consistent frontend builds
if [ -x .node/bin/node ]; then
    PATH="$PWD/.node/bin:$PATH"
fi

echo "==> Building the UI"
(cd frontend && npm ci && npm run build)

static="stretch4_nav_webapp/static"
[ -f "$static/index.html" ] || { echo "ERROR: $static/index.html missing after npm run build" >&2; exit 1; }
[ -d "$static/assets" ] || { echo "ERROR: $static/assets missing after npm run build" >&2; exit 1; }

echo "==> Building the wheel and the sdist"
rm -rf dist build ./*.egg-info
uv build

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

uvx twine check dist/*

cat <<'MSG'

==> Ready. Upload with:
      uv publish --token <pypi-token>

    Test it first if you like:
      uv publish --publish-url https://test.pypi.org/legacy/ --token <testpypi-token>

    Or set UV_PUBLISH_TOKEN in the environment and drop the --token flag.
MSG
