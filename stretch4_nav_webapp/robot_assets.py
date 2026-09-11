"""Serve Stretch URDF mesh assets for the web RobotModel viewer."""

from __future__ import annotations

import functools
import logging
import re
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_PACKAGE_RE = re.compile(r'package://([^/]+)/')


@functools.lru_cache(maxsize=1)
def _candidate_roots() -> tuple[Path, ...]:
    roots: list[Path] = []
    try:
        import stretch4_urdf

        pkg = Path(stretch4_urdf.__file__).resolve().parent
        roots.append(pkg)
    
        for child in pkg.rglob('meshes'):
            if child.is_dir():
                roots.append(child.parent)
                break
    except Exception as exc:
        logger.debug('stretch4_urdf not importable: %s', exc)

    try:
        from ament_index_python.packages import get_package_share_directory

        for name in ('stretch4_urdf', 'stretch_description', 'stretch_core'):
            try:
                roots.append(Path(get_package_share_directory(name)))
            except Exception:
                pass
    except Exception:
        pass

    # Deduplicate
    seen = set()
    unique = []
    for r in roots:
        key = str(r)
        if key not in seen and r.exists():
            seen.add(key)
            unique.append(r)
    return tuple(unique)


def resolve_mesh_path(rel_path: str) -> Optional[Path]:
    """Resolve a package-relative or bare mesh path under known roots."""
    rel = rel_path.lstrip('/')
    parts = Path(rel).parts
    name = Path(rel).name
    roots = _candidate_roots()

    for root in roots:
        for i in range(len(parts)):
            candidate = root.joinpath(*parts[i:])
            if candidate.is_file():
                return candidate.resolve()
        candidate = root / 'meshes' / name
        if candidate.is_file():
            return candidate.resolve()

    # Deep search by filename as last resort. Mesh filenames are shared
    # across tool variants (e.g. quick_connect_interface_link.STL), so
    # prefer a match whose parent directories agree with the request path.
    for root in roots:
        if not name:
            continue
        matches = list(root.rglob(name))
        if matches:
            wanted = set(parts[:-1])
            matches.sort(key=lambda m: -len(wanted & set(m.parts)))
            return matches[0].resolve()
    return None


def mesh_version_token(rel_path: str) -> Optional[str]:
    """Version tag for a mesh URL, changing whenever the file on disk does."""
    path = resolve_mesh_path(rel_path)
    if not path:
        return None
    try:
        st = path.stat()
    except OSError:
        return None
    return f'{int(st.st_mtime)}-{st.st_size}'


def rewrite_urdf_mesh_urls(urdf_xml: str, mesh_base_url: str) -> str:
    """Rewrite package:// and file:// mesh hrefs to HTTP mesh API URLs."""
    base = mesh_base_url.rstrip('/')

    def repl_package(match: re.Match) -> str:
        pkg = match.group(1)
        return f'{base}/{pkg}/'

    text = _PACKAGE_RE.sub(repl_package, urdf_xml)
    # file:///.../share/pkg/meshes/foo.stl → /api/robot/meshes/pkg/meshes/foo.stl
    text = re.sub(
        r'filename="file://[^"]*?/(stretch4_urdf|stretch_description|stretch_core)/([^"]+)"',
        rf'filename="{base}/\1/\2"',
        text,
    )

    def add_version(match: re.Match) -> str:
        rel = match.group(1)
        token = mesh_version_token(rel)
        if not token:
            return match.group(0)
        return f'filename="{base}/{rel}?v={token}"'

    return re.sub(
        rf'filename="{re.escape(base)}/([^"?]+)"',
        add_version,
        text,
    )
